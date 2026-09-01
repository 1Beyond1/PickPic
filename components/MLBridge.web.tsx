/**
 * The ML bridge is native-only. Keep the web entry point importable so the
 * native ML Kit packages are not evaluated by the web bundle.
 */

export const mlBridgeQueue = {
    isAvailable: () => false,
    push: () => {
        throw new Error('ML bridge is unavailable on web');
    },
    cancel: () => false,
};

export function MLBridge() {
    return null;
}
