import { apiClient } from "./client";

export interface PersonaConfig {
  name?: string;
  tone?: string;
  relationship?: string;
  language?: string;
  communication_style?: string;
  empathy?: string;
  preference_focus?: string;
}

export const personaApi = {
  async get(): Promise<{ ok: boolean; persona: PersonaConfig }> {
    return apiClient.get<{ ok: boolean; persona: PersonaConfig }>("persona");
  },

  async update(body: PersonaConfig): Promise<{ ok: boolean; persona: PersonaConfig }> {
    return apiClient.patch<{ ok: boolean; persona: PersonaConfig }>("persona", body);
  },
};

