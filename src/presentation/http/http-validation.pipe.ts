import type { ArgumentMetadata, PipeTransform } from "@nestjs/common";
import { z } from "zod";
import { HttpContractError } from "./http-contract-error";

export class HttpValidationPipe implements PipeTransform {
  transform(value: unknown, { metatype }: ArgumentMetadata): unknown {
    if (!metatype || !("schema" in metatype) || !(metatype.schema instanceof z.ZodType)) {
      return value;
    }
    const result = metatype.schema.safeParse(value);
    if (!result.success) {
      throw new HttpContractError(
        400,
        "INVALID_REQUEST",
        "Request fields do not match the API contract",
      );
    }
    return result.data;
  }
}
