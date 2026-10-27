import { execFile } from "node:child_process";
import { promisify } from "node:util";

// flock protects only this short transaction, not the workflow lifetime. The
// stable guard inode is never unlinked: unlinking it would create two mutexes.
export const RUN_LOCK_HELPER = String.raw`
import fcntl, json, os, socket, subprocess, sys, tempfile, time

directory, operation, pid, token = sys.argv[1:5]
resource_owner = sys.argv[5] if len(sys.argv) > 5 else ''
pid = int(pid)
path = os.path.join(directory, 'lock')
guard = os.path.join(directory, 'lock.guard')
legacy_gate = path + '.reclaim'
gate_marker = 'pi-workflow-lock-v2-kernel-guard'
host = socket.gethostname()

def process_identity(owner_pid):
    # Wall-clock ages and ps-formatted dates cannot prove process identity.
    # Use boot-scoped kernel start times, and fail closed if inspection fails.
    try:
        if sys.platform == 'linux':
            with open('/proc/sys/kernel/random/boot_id') as stream:
                boot = stream.read().strip()
            namespace = os.readlink('/proc/self/ns/pid')
            with open('/proc/%d/stat' % owner_pid) as stream:
                start = stream.read().rsplit(')', 1)[1].split()[19]
            return dict(kind='linux', boot=boot, namespace=namespace, start=start)
        if sys.platform == 'darwin':
            import ctypes
            class BSDInfo(ctypes.Structure):
                # proc_bsdinfo from sys/proc_info.h (PROC_PIDTBSDINFO = 3).
                _fields_ = [('ids', ctypes.c_uint32 * 12), ('comm', ctypes.c_char * 16),
                            ('name', ctypes.c_char * 32), ('misc', ctypes.c_uint32 * 6),
                            ('start_sec', ctypes.c_uint64), ('start_usec', ctypes.c_uint64)]
            library = ctypes.CDLL('/usr/lib/libproc.dylib')
            query = library.proc_pidinfo
            query.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
            query.restype = ctypes.c_int
            info = BSDInfo()
            if query(owner_pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info)) != ctypes.sizeof(info) or info.ids[3] != owner_pid:
                return None
            boot = subprocess.check_output(['/usr/sbin/sysctl', '-n', 'kern.bootsessionuuid'], text=True, timeout=2).strip()
            return dict(kind='darwin', boot=boot, namespace='host', start='%d:%d' % (info.start_sec, info.start_usec))
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return None
    return None

def valid_identity(value):
    return isinstance(value, dict) and all(isinstance(value.get(key), str) and value[key] for key in ('kind', 'boot', 'namespace', 'start'))

def emit(value):
    print(json.dumps(value))

def read_owner():
    try:
        with open(path) as stream:
            value = json.load(stream)
        return value if isinstance(value, dict) else {}
    except FileNotFoundError:
        return None
    except (ValueError, UnicodeError):
        return {}

def alive(owner_pid):
    try:
        os.kill(owner_pid, 0)
        # A zombie cannot execute or own work, even though kill(pid, 0) succeeds.
        if sys.platform == 'linux':
            try:
                with open('/proc/%d/stat' % owner_pid) as stream:
                    if stream.read().rsplit(')', 1)[1].split()[0] == 'Z':
                        return False
            except FileNotFoundError:
                return False
        elif sys.platform == 'darwin':
            state = subprocess.check_output(['ps', '-o', 'stat=', '-p', str(owner_pid)], text=True, timeout=2).strip()
            if state.startswith('Z'):
                return False
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except (OSError, subprocess.SubprocessError):
        return True

def transaction():
    # A killed helper may leave an unpublished record. No other new helper can
    # be publishing while we hold flock, so cleanup never removes a live writer.
    for name in os.listdir(directory):
        if name.startswith('.lock-owner-'):
            os.unlink(os.path.join(directory, name))
    owner = read_owner()
    reclaimed_resource_owner = None
    if operation == 'release':
        if owner and owner.get('token') == token and owner.get('pid') == pid:
            os.unlink(path)
        return dict(ok=True)
    requester_identity = process_identity(pid)
    if os.getppid() != pid:
        raise RuntimeError('workflow lock requester exited during identity inspection')
    if not valid_identity(requester_identity):
        raise RuntimeError('cannot inspect workflow lock requester identity; refusing PID-only ownership')
    if owner is not None:
        owner_pid = owner.get('pid')
        if type(owner_pid) is not int or not 0 < owner_pid <= 2147483647:
            return dict(ok=False, ownerPid=0, reason='lock owner is unreadable; manual inspection required')
        if owner.get('host', host) != host:
            return dict(ok=False, ownerPid=owner_pid, reason='lock belongs to another host; refusing local PID inference')
        previous = owner.get('identity')
        if not valid_identity(previous):
            return dict(ok=False, ownerPid=owner_pid, reason='legacy lock owner identity is unreadable; manual inspection required')
        if previous['kind'] != requester_identity['kind']:
            return dict(ok=False, ownerPid=owner_pid, reason='cannot verify lock process identity; refusing takeover')
        if previous['boot'] == requester_identity['boot'] and previous['namespace'] != requester_identity['namespace']:
            return dict(ok=False, ownerPid=owner_pid, reason='lock belongs to another PID namespace; refusing local PID inference')
        if alive(owner_pid):
            current = process_identity(owner_pid)
            if not valid_identity(previous) or not valid_identity(current) or previous['kind'] != current['kind']:
                return dict(ok=False, ownerPid=owner_pid)
            if previous['boot'] == current['boot']:
                if previous['namespace'] != current['namespace']:
                    return dict(ok=False, ownerPid=owner_pid, reason='lock belongs to another PID namespace; refusing local PID inference')
                if previous['start'] == current['start']:
                    return dict(ok=False, ownerPid=owner_pid)
            # Same host but a different boot, or a proven different incarnation
            # of this PID. The process which published this record cannot live.
        reclaimed_resource_owner = owner.get('resourceOwner')
        os.unlink(path)
    fd, temporary = tempfile.mkstemp(prefix='.lock-owner-', dir=directory)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(dict(version=2, pid=pid, token=token, host=host, identity=requester_identity, resourceOwner=resource_owner, at=int(time.time()*1000)), stream)
            stream.flush()
            os.fsync(stream.fileno())
        # Publish a complete record without overwriting even an old-version
        # contender which does not participate in our kernel guard protocol.
        try:
            os.link(temporary, path)
        except FileExistsError:
            return dict(ok=False, ownerPid=0, reason='another owner published the lock')
        return dict(ok=True, path=path, reclaimedResourceOwner=reclaimed_resource_owner)
    finally:
        os.unlink(temporary)

def guarded_transaction():
    # An old executable's mkdir-based recovery must also see us as a contender.
    # New gates are identifiable atomic symlinks; flock proves no new transaction
    # is still using a gate left behind by a killed helper. Unknown old directories
    # remain untouched because their critical section cannot be proven abandoned.
    try:
        os.symlink(gate_marker, legacy_gate)
    except FileExistsError:
        if not os.path.islink(legacy_gate) or os.readlink(legacy_gate) != gate_marker:
            return dict(ok=False, ownerPid=0, reason='legacy lock.reclaim has no owner identity; manual inspection required')
        os.unlink(legacy_gate)
        os.symlink(gate_marker, legacy_gate)
    try:
        return transaction()
    finally:
        os.unlink(legacy_gate)

if os.getppid() != pid:
    raise RuntimeError('workflow lock requester exited before helper startup')
with open(guard, 'a+b') as mutex:
    try:
        fcntl.flock(mutex.fileno(), fcntl.LOCK_EX | (fcntl.LOCK_NB if operation == 'acquire' else 0))
    except BlockingIOError:
        emit(dict(ok=False, ownerPid=0, reason='another lock transaction is active; retry shortly'))
    else:
        emit(guarded_transaction())
`;

export type RunLockResult = { ok: true; path: string; reclaimedResourceOwner?: string | null } | { ok: false; ownerPid: number; reason?: string };

export async function runLockTransaction(directory: string, operation: "acquire" | "release", token: string, resourceOwner = ""): Promise<RunLockResult> {
  let stdout: string;
  try {
    ({ stdout } = await promisify(execFile)("python3", ["-c", RUN_LOCK_HELPER, directory, operation, String(process.pid), token, resourceOwner], {
      encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024,
    }));
  } catch (error: any) {
    const detail = error.killed && error.code === null
      ? "python3 transaction timed out after 10000ms"
      : typeof error.code === "number" || error.signal ? error.stderr?.trim() ?? "" : error.message;
    throw new Error(`Workflow lock transaction failed (Python 3 with fcntl is required): ${detail}`);
  }
  return JSON.parse(stdout);
}
