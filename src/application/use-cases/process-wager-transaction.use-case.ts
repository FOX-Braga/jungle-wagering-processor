import { InboxMessage } from "../../domain/messaging/inbox-message";
import { FailureCode } from "../../domain/shared/failure-code";
import type { Wallet } from "../../domain/wallet/wallet";
import {
  WagerTransaction,
  WagerTransactionKind as Kind,
  WagerTransactionStatus as Status,
} from "../../domain/wagering/wager-transaction";
import type { EventTrace, InboxReceipt, ProcessWagerCommand } from "../commands/financial-commands";
import { ApplicationError } from "../errors/application-error";
import type { FinancialRuntime } from "../ports/financial-runtime";
import type {
  FinancialRepositories,
  InboxRepository,
  PersistedWager,
} from "../ports/repositories/financial-repositories";
import { PersistenceUniqueError, type TransactionManager } from "../ports/transaction-manager";
import {
  processResult,
  walletSnapshot,
  type ProcessWagerResult,
} from "../results/financial-results";
import { hashWagerPayload } from "../services/canonical-wager";
import { enqueueWagerEvents } from "../services/financial-events";
import {
  commandMoney,
  identifier,
  traceIdentifiers,
  validateDomain,
} from "../services/financial-input";

const retryableUniqueResources = ["wager-idempotency", "wager-external", "inbox-message"] as const;

interface ReferenceRetryPolicy {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export class ProcessWagerTransactionUseCase {
  constructor(
    private readonly transactions: TransactionManager,
    private readonly runtime: FinancialRuntime,
  ) {}

  async execute(command: ProcessWagerCommand): Promise<ProcessWagerResult> {
    const transaction = await this.prepareTransaction(command);

    try {
      return await this.transactions.execute(async (repos) => {
        const previous = await this.findReplay(repos, transaction, command.inbox);
        if (previous) return previous;

        const wallet = await this.lockWallet(repos, transaction);
        // READ COMMITTED lets us see a predecessor that finished while we waited for this wallet.
        const concurrent = await this.findReplay(repos, transaction, command.inbox);
        if (concurrent) return concurrent;

        return this.apply(repos, transaction, wallet, command, command.inbox);
      });
    } catch (error) {
      if (
        !(error instanceof PersistenceUniqueError) ||
        !retryableUniqueResources.some((resource) => resource === error.resource)
      )
        throw error;
      // The losing transaction is rolled back. Only read or record the replay receipt in a fresh transaction.
      return this.transactions.execute(async (repos) => {
        const replay = await this.findReplay(repos, transaction, command.inbox);
        if (!replay) throw error;
        return replay;
      });
    }
  }

  async resumePending(transactionId: string, trace: EventTrace = {}): Promise<ProcessWagerResult> {
    const result = await this.resume(transactionId, trace);
    if (!result) throw new Error("Manual resume returned no result");
    return result;
  }

  async retryPendingReference(
    transactionId: string,
    policy: ReferenceRetryPolicy,
  ): Promise<ProcessWagerResult | undefined> {
    return this.resume(transactionId, {}, policy);
  }

  private async resume(
    transactionId: string,
    trace: EventTrace,
    policy?: ReferenceRetryPolicy,
  ): Promise<ProcessWagerResult | undefined> {
    identifier(transactionId, "transactionId");
    traceIdentifiers(trace);
    return this.transactions.execute(async (repos) => {
      const initial = await this.requireRecord(repos, transactionId);
      if (initial.transaction.isTerminal())
        return policy ? undefined : processResult(initial, true);
      if (initial.transaction.status !== Status.PendingReference) {
        throw new ApplicationError("WAGER_NOT_PENDING", "Wager is not waiting for a reference");
      }

      const wallet = await this.lockWallet(repos, initial.transaction);
      const current = await this.requireRecord(repos, transactionId);
      if (current.transaction.isTerminal())
        return policy ? undefined : processResult(current, true);
      if (current.transaction.status !== Status.PendingReference) {
        throw new ApplicationError("WAGER_NOT_PENDING", "Wager is not waiting for a reference");
      }
      if (
        policy &&
        current.referenceNextAttemptAt &&
        current.referenceNextAttemptAt > this.runtime.clock.now()
      ) {
        return undefined;
      }
      return this.apply(repos, current.transaction, wallet, trace, undefined, current, policy);
    });
  }

  private async prepareTransaction(command: ProcessWagerCommand): Promise<WagerTransaction> {
    const providerId = identifier(command.providerId, "providerId");
    const externalTransactionId = identifier(
      command.externalTransactionId,
      "externalTransactionId",
    );
    const idempotencyKey = identifier(command.idempotencyKey, "idempotencyKey");
    const walletId = identifier(command.walletId, "walletId");
    const playerId = identifier(command.playerId, "playerId");
    const roundId = identifier(command.roundId, "roundId");
    const gameId = identifier(command.gameId, "gameId");
    const referenceExternalTransactionId = command.referenceExternalTransactionId;
    const money = commandMoney(command.money);
    traceIdentifiers(command);
    if (command.inbox !== undefined) {
      if (!command.inbox) throw new ApplicationError("INVALID_COMMAND", "Invalid inbox receipt");
      identifier(command.inbox.consumerName, "consumerName");
      identifier(command.inbox.messageId, "messageId");
    }
    if (providerId === "system:wallet-opening" || idempotencyKey.startsWith("internal:opening:")) {
      throw new ApplicationError("INVALID_COMMAND", "The wallet opening namespace is reserved");
    }

    const kind = command.kind;
    if (kind === Kind.Opening || !Object.values(Kind).includes(kind)) {
      throw new ApplicationError("INVALID_COMMAND", "Invalid external wager kind");
    }
    const reference =
      referenceExternalTransactionId === undefined
        ? {}
        : {
            referenceExternalTransactionId: identifier(
              referenceExternalTransactionId,
              "referenceExternalTransactionId",
            ),
          };
    const payload = {
      providerId,
      externalTransactionId,
      idempotencyKey,
      walletId,
      playerId,
      roundId,
      gameId,
      kind,
      ...reference,
    };
    const payloadHash = await hashWagerPayload({ ...payload, money: money.toJSON() }, money);
    return validateDomain(() =>
      WagerTransaction.create({
        ...payload,
        money,
        payloadHash,
        id: this.runtime.ids.next(),
        createdAt: this.runtime.clock.now(),
      }),
    );
  }

  private async findReplay(
    repos: FinancialRepositories,
    proposed: WagerTransaction,
    receipt: InboxReceipt | undefined,
  ): Promise<ProcessWagerResult | undefined> {
    const inbox = receipt
      ? await repos.inbox.find(receipt.consumerName, receipt.messageId)
      : undefined;
    if (inbox && inbox.payloadHash !== proposed.payloadHash) {
      throw new ApplicationError(
        "INBOX_CONFLICT",
        "The inbox message is already bound to another payload",
      );
    }

    const byKey = await repos.wagers.findByIdempotencyKey(proposed.idempotencyKey);
    const record =
      byKey ??
      (await repos.wagers.findByExternalId(proposed.providerId, proposed.externalTransactionId));
    if (record) {
      if (record.transaction.idempotencyKey !== proposed.idempotencyKey) {
        throw new ApplicationError(
          "EXTERNAL_TRANSACTION_CONFLICT",
          "The provider transaction ID already has an idempotency key",
        );
      }
      if (!record.transaction.matchesPayload(proposed.payloadHash)) {
        throw new ApplicationError(
          "IDEMPOTENCY_CONFLICT",
          "The idempotency key is already bound to another payload",
        );
      }
      const replay = processResult(record, true);
      await this.recordReceipt(
        repos.inbox,
        receipt,
        proposed.payloadHash,
        this.runtime.clock.now(),
        true,
      );
      return replay;
    }

    if (inbox?.isProcessed()) {
      throw new ApplicationError(
        "INBOX_CONFLICT",
        "The processed inbox message has no matching wager",
      );
    }
    return undefined;
  }

  private async lockWallet(
    repos: FinancialRepositories,
    transaction: WagerTransaction,
  ): Promise<Wallet> {
    const wallet = await repos.wallets.lockById(transaction.walletId);
    if (!wallet) throw new ApplicationError("WALLET_NOT_FOUND", "Wallet not found");
    if (wallet.playerId !== transaction.playerId) {
      throw new ApplicationError(
        "WALLET_OWNERSHIP_MISMATCH",
        "Wallet does not belong to the player",
      );
    }
    return wallet;
  }

  private async apply(
    repos: FinancialRepositories,
    transaction: WagerTransaction,
    wallet: Wallet,
    trace: EventTrace,
    receipt?: InboxReceipt,
    existing?: PersistedWager,
    policy?: ReferenceRetryPolicy,
  ): Promise<ProcessWagerResult> {
    const referenceId = transaction.referenceExternalTransactionId;
    const reference =
      referenceId === undefined
        ? undefined
        : (await repos.wagers.findByExternalId(transaction.providerId, referenceId))?.transaction;
    const reversals =
      reference && transaction.requiresReference()
        ? await repos.wagers.findAppliedReversals(reference.id)
        : [];
    const at = new Date(
      Math.max(
        this.runtime.clock.now().getTime(),
        transaction.createdAt.getTime(),
        wallet.updatedAt.getTime(),
        existing?.updatedAt.getTime() ?? -Infinity,
      ),
    );
    const outcome = transaction.apply(wallet, {
      at,
      ledgerEntryId: this.runtime.ids.next(),
      appliedReversals: reversals,
      ...(reference ? { reference } : {}),
    });
    let referenceAttempts: number | undefined;
    if (existing && outcome.status === Status.PendingReference) {
      if (!policy) return processResult(existing, true);
      const attempts = (existing.referenceAttempts ?? 0) + 1;
      if (attempts < policy.maxAttempts) {
        const delay = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempts - 1));
        await repos.wagers.scheduleReferenceRetry(
          transaction.id,
          attempts,
          new Date(at.getTime() + delay),
        );
        return processResult(
          { ...existing, result: existing.result ?? walletSnapshot(wallet) },
          true,
        );
      }
      transaction.reject(FailureCode.ReferenceNotFound);
      referenceAttempts = attempts;
    }

    const details = {
      updatedAt: at,
      result: walletSnapshot(wallet),
      ...(referenceAttempts === undefined ? {} : { referenceAttempts }),
    };
    if (existing) await repos.wagers.saveState(transaction, details);
    else await repos.wagers.insert(transaction, details);
    const entry = outcome.status === Status.Processed ? outcome.ledgerEntry : undefined;
    if (entry) await repos.wallets.saveMovement(wallet, entry);
    await enqueueWagerEvents(
      repos.outbox,
      transaction,
      entry,
      at,
      {
        ...trace,
        ...(trace.causationId === undefined && receipt ? { causationId: receipt.messageId } : {}),
      },
      this.runtime.ids,
    );
    if (receipt) await this.recordReceipt(repos.inbox, receipt, transaction.payloadHash, at, false);
    return processResult({ transaction, ...details }, false);
  }

  private async recordReceipt(
    repository: InboxRepository,
    receipt: InboxReceipt | undefined,
    hash: string,
    at: Date,
    replaying: boolean,
  ): Promise<void> {
    if (!receipt) return;
    const previous = await repository.find(receipt.consumerName, receipt.messageId, {
      forUpdate: true,
    });
    if (previous) {
      if (previous.payloadHash !== hash || (previous.isProcessed() && !replaying)) {
        throw new ApplicationError(
          "INBOX_CONFLICT",
          "The inbox receipt already records another operation",
        );
      }
      if (previous.isProcessed()) return;
      previous.markProcessed(new Date(Math.max(at.getTime(), previous.receivedAt.getTime())));
      await repository.saveProcessed(previous);
      return;
    }

    const message = InboxMessage.receive({ ...receipt, receivedAt: at, payloadHash: hash });
    message.markProcessed(at);
    await repository.insert(message);
  }

  private async requireRecord(repos: FinancialRepositories, id: string): Promise<PersistedWager> {
    const record = await repos.wagers.findById(id);
    if (!record) throw new ApplicationError("WAGER_NOT_FOUND", "Wager not found");
    return record;
  }
}
