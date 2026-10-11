import { lazy, Suspense } from 'react';
import { useHumanInTheLoop } from '@copilotkit/react-core/v2';
import {
  expungeReviewSchema,
  expungeReviewTool,
} from '../../../shared/expunge';

/**
 * The client half of the review tool registration. The backend half is the allowlist in
 * ExpungeProjectionAgent; both import the name from shared/expunge.ts, so they cannot drift.
 * The card is a separate lazy chunk, so the shell loads none of the review UI until a review
 * tool call is rendered.
 */
const ReviewCard = lazy(() => import('./ReviewCard'));

export const reviewToolRegistration = {
  name: expungeReviewTool.name,
  description: expungeReviewTool.description,
  parameters: expungeReviewSchema,
} as const;

/** Mount once inside CopilotKitProvider. Renders nothing itself. */
export function ExpungeReviewTool() {
  useHumanInTheLoop(
    {
      ...reviewToolRegistration,
      render: (props) => (
        <Suspense fallback={<p>Loading review</p>}>
          <ReviewCard {...props} />
        </Suspense>
      ),
    },
    [],
  );
  return null;
}
