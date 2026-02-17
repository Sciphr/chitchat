import { RnnoiseWorkletNode, loadRnnoise } from "@sapphi-red/web-noise-suppressor";

import rnnoiseWorkletUrl from "@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url";
import rnnoiseWasmUrl from "@sapphi-red/web-noise-suppressor/rnnoise.wasm?url";
import rnnoiseWasmSimdUrl from "@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url";

type AudioProcessorInitOptions = {
  track: MediaStreamTrack;
  audioContext: AudioContext;
};

let rnnoiseBinaryPromise: Promise<ArrayBuffer> | null = null;
let workletLoadPromise: Promise<void> | null = null;

async function loadWorklet(context: AudioContext) {
  if (!workletLoadPromise) {
    workletLoadPromise = context.audioWorklet.addModule(rnnoiseWorkletUrl);
  }
  await workletLoadPromise;
}

async function loadBinary() {
  if (!rnnoiseBinaryPromise) {
    rnnoiseBinaryPromise = loadRnnoise({
      url: rnnoiseWasmUrl,
      simdUrl: rnnoiseWasmSimdUrl,
    });
  }
  return rnnoiseBinaryPromise;
}

export class LiveKitRnnoiseProcessor {
  name = "rnnoise";
  processedTrack?: MediaStreamTrack;

  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private processorNode: RnnoiseWorkletNode | null = null;
  private destinationNode: MediaStreamAudioDestinationNode | null = null;

  async init(opts: AudioProcessorInitOptions) {
    await this.setup(opts);
  }

  async restart(opts: AudioProcessorInitOptions) {
    await this.destroy();
    await this.setup(opts);
  }

  async destroy() {
    this.sourceNode?.disconnect();
    this.processorNode?.disconnect();
    this.destinationNode?.disconnect();
    this.processorNode?.destroy();
    this.processedTrack?.stop();
    this.sourceNode = null;
    this.processorNode = null;
    this.destinationNode = null;
    this.processedTrack = undefined;
  }

  private async setup({ track, audioContext }: AudioProcessorInitOptions) {
    if (track.kind !== "audio") {
      throw new Error("RNNoise processor requires an audio track");
    }
    await loadWorklet(audioContext);
    const wasmBinary = await loadBinary();

    const sourceStream = new MediaStream([track]);
    const sourceNode = audioContext.createMediaStreamSource(sourceStream);
    const processorNode = new RnnoiseWorkletNode(audioContext, {
      wasmBinary,
      maxChannels: 1,
    });
    const destinationNode = audioContext.createMediaStreamDestination();

    sourceNode.connect(processorNode);
    processorNode.connect(destinationNode);

    const [processedTrack] = destinationNode.stream.getAudioTracks();
    if (!processedTrack) {
      throw new Error("RNNoise failed to provide a processed audio track");
    }

    this.sourceNode = sourceNode;
    this.processorNode = processorNode;
    this.destinationNode = destinationNode;
    this.processedTrack = processedTrack;
  }
}

export function supportsRnnoiseProcessing() {
  return (
    typeof window !== "undefined" &&
    typeof AudioContext !== "undefined" &&
    typeof AudioWorkletNode !== "undefined"
  );
}
