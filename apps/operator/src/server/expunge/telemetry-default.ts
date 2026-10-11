// Side-effect module: it must be the first import of the server entry. ES modules evaluate their
// imports in order, so this runs before the CopilotKit runtime and its telemetry code load.
import { applyTelemetryDefault } from './config.js';

applyTelemetryDefault(process.env);
