import { isUtf8 } from "node:buffer";
import { SecretRequestError, type SecretFormat } from "./types";

export function secretLength(value: Uint8Array, format: SecretFormat, minLength = 1): number {
  if (value.length > 4096) throw new SecretRequestError("secret_value_too_long");
  if (!isUtf8(value)) throw new SecretRequestError("secret_value_format");
  let length = 0;
  for (let index = 0; index < value.length; index++) {
    const byte = value[index];
    const control = byte < 0x20 || byte === 0x7f
      || (byte === 0xc2 && value[index + 1] >= 0x80 && value[index + 1] <= 0x9f);
    if (control || (format === "token" && (byte < 0x21 || byte > 0x7e))) {
      throw new SecretRequestError("secret_value_format");
    }
    if ((byte & 0xc0) !== 0x80) length++;
  }
  if (length < minLength) throw new SecretRequestError("secret_value_format");
  return length;
}
