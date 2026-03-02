/**
 * Voice-synthesis configuration, persisted to disk.
 */

export interface VoiceConfig {
  defaultVoice: string;
  voiceMode: boolean;
  localMode: boolean;
  personas: Record<string, string>;
}

/** Voice mode settings */
export type VoiceMode = "off" | "listen" | "speak" | "both";

/** Per-contact persona override */
export interface PersonaConfig {
  contactPattern: string;
  voice: string;
}
