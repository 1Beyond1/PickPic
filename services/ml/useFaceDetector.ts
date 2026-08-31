export interface FaceDetectorResult {
    faces?: Array<{
        frame: {
            origin: { x: number; y: number };
            size: { x: number; y: number };
        };
    }>;
}

export interface FaceDetectorLike {
    detectFaces(imageUri: string): Promise<FaceDetectorResult | undefined>;
}

// The app's supported native platforms provide the real implementation in
// platform-specific files. Keep a safe fallback for tooling and any platform
// without ML Kit support: callers will treat the missing result as a failed
// detection instead of a successful empty result.
const unavailableFaceDetector: FaceDetectorLike = {
    detectFaces: async () => undefined,
};

export function useFaceDetector(): FaceDetectorLike {
    return unavailableFaceDetector;
}
