import { assertOperatorEnvironment } from './operator-environment.js';

// First server import: --env-file and inherited variables are checked before stores or services start.
assertOperatorEnvironment(process.env);
