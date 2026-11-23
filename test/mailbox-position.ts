import { Effect, Option } from "effect";
import { Ledger } from "../src/Ledger.ts";

export const mailboxPosition = (address: string) =>
  Effect.gen(function* () {
    const ledger = yield* Ledger;
    const state = yield* ledger.mailboxAt(address, (yield* ledger.presenceAt()).cut);
    return state.status === "FOUND" ? Option.some(state.position) : Option.none();
  });
