import { HttpException } from "@nestjs/common";

export class HttpContractError extends HttpException {
  constructor(
    status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message, status);
  }
}
