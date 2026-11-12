import * as Domain from "@alchemy.run/domain";
import * as Schema from "effect/Schema";
import { ReviewId } from "./content-state.ts";

export class ReviewFinal extends Domain.Rejection("ReviewFinal", {
    id: ReviewId,
    decision: Schema.Literals(["approved", "rejected", "deleted"]),
}) {}
