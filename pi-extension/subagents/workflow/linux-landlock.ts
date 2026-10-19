/**
 * Linux Landlock wrapper for verify_command.
 *
 * bwrap's read-only mounts already refuse creating, deleting, renaming and
 * truncating through the workspace. What a read-only mount does not cover is
 * opening an *existing* non-regular object (a FIFO or a device) for writing:
 * that open succeeds under bwrap alone. Landlock closes exactly that path.
 *
 * Contract, fixed by the launcher:
 *   python3 -I -S -c LINUX_LANDLOCK_EXEC <scratch> <program> [args...]
 *
 * - argv[1] is the writable scratch directory, argv[2..] the command to exec.
 * - Handled rights are WRITE_FILE, plus TRUNCATE when the kernel ABI is >= 3.
 *   Any ABI >= 1 (Linux 5.13+) is accepted; on older ABIs a read-only mount
 *   already makes truncate(2) fail.
 * - The ruleset allows those rights only on the scratch directory and
 *   /dev/null. Reads and exec are not handled, so they stay unrestricted.
 * - On any setup error - including an unexpected exception from ctypes,
 *   os.write or os.close - the script writes "Landlock setup failed: ..." to
 *   stderr and exits 125 without ever executing the command.
 * - On success it writes exactly "pi-verify-landlock-ready" + newline to fd 2
 *   and then execs the command in place.
 *
 * The script is delivered as raw text (String.raw), so the Python escapes in
 * this source are the escapes Python sees; nothing from the caller is
 * interpolated and the command arrives as positional arguments.
 */
export const LINUX_LANDLOCK_EXEC = String.raw`import ctypes
import os
import struct
import sys

CREATE_RULESET = 444
ADD_RULE = 445
RESTRICT_SELF = 446
RULESET_VERSION = 1
PR_SET_NO_NEW_PRIVS = 38
WRITE_FILE = 1 << 1
TRUNCATE = 1 << 14


def fail(message):
    try:
        sys.stderr.write("Landlock setup failed: " + message + "\n")
        sys.stderr.flush()
    except BaseException:
        pass
    os._exit(125)


class RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]


def allow(libc, ruleset, mask, path):
    fd = os.open(path, os.O_PATH | os.O_CLOEXEC)
    # The kernel UAPI is packed (u64, s32), exactly 12 bytes with no padding.
    data = struct.pack("=Qi", mask, fd)
    rule = ctypes.create_string_buffer(data, len(data))
    rc = libc.syscall(ctypes.c_long(ADD_RULE), ctypes.c_int(ruleset), ctypes.c_int(1),
                      ctypes.byref(rule), ctypes.c_uint32(0))
    err = ctypes.get_errno()
    os.close(fd)
    if rc != 0:
        fail("add_rule " + path + ": " + os.strerror(err))


def main():
    if len(sys.argv) < 3:
        fail("usage: <scratch> <program> [args...]")

    scratch = sys.argv[1]
    libc = ctypes.CDLL(None, use_errno=True)

    abi = libc.syscall(ctypes.c_long(CREATE_RULESET), ctypes.c_void_p(0),
                       ctypes.c_size_t(0), ctypes.c_uint32(RULESET_VERSION))
    if abi < 0:
        fail("create_ruleset version probe: " + os.strerror(ctypes.get_errno()))
    if abi < 1:
        fail("kernel ABI " + str(abi) + "; Landlock is missing")

    # bwrap mounts already refuse creating, deleting, renaming and truncating
    # through the workspace. The one write path a read-only mount does not cover
    # is opening an existing non-regular object (FIFO, device) for writing, which
    # is exactly WRITE_FILE. TRUNCATE is added when the ABI supports it; on older
    # ABIs a read-only mount already fails truncate(2).
    mask = WRITE_FILE
    if abi >= 3:
        mask |= TRUNCATE

    attr = RulesetAttr(mask)
    ruleset = libc.syscall(ctypes.c_long(CREATE_RULESET), ctypes.byref(attr),
                           ctypes.c_size_t(ctypes.sizeof(attr)), ctypes.c_uint32(0))
    if ruleset < 0:
        fail("create_ruleset: " + os.strerror(ctypes.get_errno()))

    allow(libc, ruleset, mask, scratch)
    allow(libc, ruleset, mask, "/dev/null")

    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        fail("prctl(NO_NEW_PRIVS): " + os.strerror(ctypes.get_errno()))

    if libc.syscall(ctypes.c_long(RESTRICT_SELF), ctypes.c_int(ruleset), ctypes.c_uint32(0)) != 0:
        fail("restrict_self: " + os.strerror(ctypes.get_errno()))

    os.close(ruleset)
    os.write(2, b"pi-verify-landlock-ready\n")
    os.execv(sys.argv[2], sys.argv[2:])


# Any unexpected failure - ctypes, os.write, os.close, exec - must end here:
# the command is never executed without the sandbox actually being applied.
try:
    main()
except BaseException as error:
    fail(str(error) or type(error).__name__)`;
