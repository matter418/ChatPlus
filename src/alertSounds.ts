// Alert sounds for the "Alert words" feature. Five are synthesised with the Web Audio
// API so the plugin needs no audio assets; "Idle Alert" is a bundled mp3 (below).
//
// Adding a sound: add its name to ALERT_SOUNDS and a case in playAlertSound.

// The Idle Alert tone is taken from the Idle Alert plugin for HighLite
// (https://github.com/CodyBrunson/Idle-Alert, resources/sounds/idle_alert.mp3), GPL-3.0,
// the same license as this plugin. esbuild inlines it as a data URL at build time.
import IDLE_ALERT_MP3_DATA_URL from "./sounds/idle_alert.mp3";

export const ALERT_SOUNDS = ["Ding", "Chime", "Bell", "Blip", "Knock", "Idle Alert"] as const;
export type AlertSound = (typeof ALERT_SOUNDS)[number];

let audioCtx: AudioContext | null = null;

function clampVolume(volumePct: unknown): number {
    const pct = Number(volumePct);
    return (Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) : 60) / 100;
}

/**
 * Play an alert sound.
 * @param name one of ALERT_SOUNDS; anything unknown plays nothing
 * @param volumePct 0–100
 */
export function playAlertSound(name: string, volumePct: unknown): void {
    const vol = clampVolume(volumePct);
    if (vol <= 0 || !(ALERT_SOUNDS as readonly string[]).includes(name)) return;

    if (name === "Idle Alert") {
        try {
            const a = new Audio(IDLE_ALERT_MP3_DATA_URL);
            a.volume = vol;
            void a.play().catch(() => {});
        } catch {
            // no audio device; the visual alert still fires
        }
        return;
    }

    try {
        if (!audioCtx) audioCtx = new AudioContext();
        const ctx = audioCtx;
        if (ctx.state === "suspended") ctx.resume().catch(() => {});
        const t0 = ctx.currentTime;

        // 0.25 leaves headroom: a sound's oscillators overlap (up to three at once in Bell)
        // and each peaks at 1, so the sum would clip at full volume.
        const master = ctx.createGain();
        master.gain.value = 0.25 * vol;
        master.connect(ctx.destination);

        // One enveloped oscillator: attack to `peak`, exponential decay over `dur`.
        const tone = (
            type: OscillatorType,
            freq: number,
            start: number,
            dur: number,
            peak = 1,
            endFreq?: number
        ) => {
            const osc = ctx.createOscillator();
            const g = ctx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, t0 + start);
            if (endFreq !== undefined) {
                osc.frequency.exponentialRampToValueAtTime(endFreq, t0 + start + dur);
            }
            g.gain.setValueAtTime(0.0001, t0 + start);
            g.gain.exponentialRampToValueAtTime(peak, t0 + start + 0.01);
            g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur);
            osc.connect(g);
            g.connect(master);
            osc.start(t0 + start);
            osc.stop(t0 + start + dur + 0.02);
        };

        switch (name as AlertSound) {
            case "Chime": // three-note ascending arpeggio (C6 E6 G6)
                tone("sine", 1046.5, 0, 0.5);
                tone("sine", 1318.5, 0.11, 0.5);
                tone("sine", 1568.0, 0.22, 0.7);
                break;
            case "Bell": // one long bell: fundamental + two inharmonic partials
                tone("sine", 880, 0, 1.2, 1);
                tone("sine", 880 * 2.76, 0, 0.6, 0.35);
                tone("sine", 880 * 5.4, 0, 0.3, 0.15);
                break;
            case "Blip": // short retro blip, pitch sliding up
                tone("square", 600, 0, 0.09, 0.5, 1200);
                tone("square", 900, 0.1, 0.12, 0.5, 1800);
                break;
            case "Knock": // two soft low thuds
                tone("triangle", 180, 0, 0.12, 1, 60);
                tone("triangle", 180, 0.16, 0.14, 1, 60);
                break;
            case "Ding": // two quick bell-like tones (E6 then B6)
            default:
                tone("sine", 1318.5, 0, 0.35);
                tone("sine", 1975.5, 0.12, 0.45);
                break;
        }
    } catch {
        // no audio device; the visual alert still fires
    }
}

/** Release the shared AudioContext (plugin teardown). Safe to call repeatedly. */
export function disposeAlertSounds(): void {
    audioCtx?.close().catch(() => {});
    audioCtx = null;
}
