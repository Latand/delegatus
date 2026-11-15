import { AsyncLocalStorage } from "node:async_hooks";

/*
 * A refused admission leaves nothing behind only when nothing was admitted
 * before it. The stores of this process note here each time they let a writer
 * in: a state collection's lease, a file transaction, a registry mutation. A
 * caller that must decide what a later refusal means runs its work under a
 * witness and reads how many writers had entered when the refusal was raised.
 *
 * The witness sees the stores of this process and nothing else. Work that
 * reaches another process or a network before its first write here is outside
 * it, so a caller uses the count only for work it knows to live in these
 * stores.
 */
export interface AdmissionWitness {
  /** Writers the stores of this process admitted for the witnessed work. */
  entered: number;
}

const witnessed = new AsyncLocalStorage<AdmissionWitness>();

export function witnessAdmissions<T>(witness: AdmissionWitness, work: () => T): T {
  return witnessed.run(witness, work);
}

/** A store admitted a writer: from here its callback owns effects. */
export function noteWriterAdmitted(): void {
  const witness = witnessed.getStore();
  if (witness) witness.entered += 1;
}
