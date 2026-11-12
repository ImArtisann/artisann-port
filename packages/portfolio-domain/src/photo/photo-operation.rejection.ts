import * as Domain from "@alchemy.run/domain";

export class PhotoOperationConflict extends Domain.Rejection("PhotoOperationConflict") {}
export class InvalidPhotoOperation extends Domain.Rejection("InvalidPhotoOperation") {}
