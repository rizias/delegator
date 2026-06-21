// Cross-platform `dist` clean run before `tsc` so deleted/renamed sources never leave a
// stale .js behind to ship in the published package. No external dependency (rimraf etc.).
import { rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
