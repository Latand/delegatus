import Ajv2020, { type AnySchemaObject } from "ajv/dist/2020";
import addFormats from "ajv-formats";
import pin from "./fixtures/relay_v1/owner-tools-response-schemas.json";
import index from "./fixtures/relay_v1/owner-tools-index.json";
import { toolCallResultSchema } from "./protocol";

export const ownerCaptureOperations = pin.operations as Record<string, AnySchemaObject | null>;
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
const validators = Object.fromEntries(Object.entries(ownerCaptureOperations).map(([name, schema]) => [name,
  schema ? ajv.compile({ ...schema, components: pin.components }) : null,
]));
const effects = new Map(index.map((tool) => [tool.name, tool.effect]));
const refusal = ajv.compile({ type: "object", required: ["http_status", "message"], additionalProperties: false,
  properties: { http_status: { type: "integer", minimum: 400, maximum: 499 }, message: { type: "string" } } });

/** Shared by the committed-capture regression and the existing X4 generator. */
export function assertOwnerCaptureResponse(value: unknown) {
  const response = toolCallResultSchema.parse(value);
  if (!Object.hasOwn(ownerCaptureOperations, response.tool)) throw new Error("Owner capture operation has no response schema");
  if (response.audience !== "owner" || response.effect !== effects.get(response.tool))
    throw new Error("Owner capture audience or effect does not match its index");
  if (response.status === "ok") {
    if (response.truncated || response.cursor) throw new Error("X4 captures complete route documents; relay fragments remain in X2");
    const validate = validators[response.tool];
    if (validate) {
      if (!validate(JSON.parse(response.output))) throw new Error(`${response.tool}: ${ajv.errorsText(validate.errors)}`);
    } else if (response.output !== "") throw new Error("Owner 204 capture must have empty output");
  } else if (response.status === "error") {
    if (!(response.effect === "read" && response.output === "The read failed.") && !refusal(JSON.parse(response.output)))
      throw new Error(`Owner refusal: ${ajv.errorsText(refusal.errors)}`);
  } else if (["pending", "confirmation_pending"].includes(response.status) && response.output !== "") {
    throw new Error("Pending owner capture must have empty output");
  }
  return response;
}
