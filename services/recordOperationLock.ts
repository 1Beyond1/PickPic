// A process-local mutex shared by scanning and encrypted record transfers.
// No key, password, media identifier or user data is stored here.
let owner: 'scanner' | 'backup' | null = null;
export function acquireRecordOperation(kind: 'scanner' | 'backup'): (() => void) | null {
    if (owner) return null;
    owner = kind;
    let released = false;
    return () => { if (!released) { released = true; owner = null; } };
}
export function isRecordTransferActive(): boolean { return owner === 'backup'; }
