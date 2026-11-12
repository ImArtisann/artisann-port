import * as Domain from "@alchemy.run/domain";

/** An approval of this note has started but not settled; retry once it does. */
export class NoteApprovalPending extends Domain.Rejection("NoteApprovalPending") {}
