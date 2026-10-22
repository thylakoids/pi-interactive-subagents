/** EOF also arrives after SIGKILL: the parent cannot leak its pipe endpoint. */
import { reapSurfaceOwner } from './tmux.ts';

// The parent can die before this startup acknowledgment reaches its pipe.
process.stdout.on('error', () => {});
process.stdin.once('end', () => { reapSurfaceOwner(process.argv[2]); });
process.stdin.resume();
process.stdout.write('ready\n');
