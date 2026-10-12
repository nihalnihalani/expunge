export type PrivacyErrorCode =
  | 'SourceIdConflict'
  | 'InvalidSource'
  | 'InvalidSubjectToken'
  | 'LessonRejected'
  | 'LessonNotStructural'
  | 'ErasureNotFound'
  | 'ErasureStale'
  | 'ErasureNotCancellable'
  | 'ErasureNotSubmitted'
  | 'InvalidErasureRequest'
  | 'ProviderResponseInvalid'
  | 'OrganizationUnverified'
  | 'OrganizationMismatch'
  | 'SubmissionInProgress'
  | 'SubmissionAmbiguous'
  | 'RemoteJobMismatch'
  | 'GuardIncomplete'
  | 'SubjectRegistrationRaced';

export class PrivacyError extends Error {
  constructor(
    readonly code: PrivacyErrorCode,
    readonly detail?: string,
  ) {
    super(detail ? `${code}:${detail}` : code);
    this.name = 'PrivacyError';
  }
}
