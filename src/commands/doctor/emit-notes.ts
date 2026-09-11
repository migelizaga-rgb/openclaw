// Doctor note emission helpers that sanitize user-visible repair output.
import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";

/** Strip terminal control sequences from a potentially multi-line doctor note. */
export function sanitizeDoctorNote(note: string): string {
  return note
    .split("\n")
    .map((line) => sanitizeForLog(line))
    .join("\n");
}

/** Emit grouped doctor change, info, and warning notes with sanitized content. */
export function emitDoctorNotes(params: {
  note: (message: string, title?: string) => void;
  changeNotes?: string[];
  infoNotes?: string[];
  warningNotes?: string[];
}): void {
  for (const change of params.changeNotes ?? []) {
    params.note(sanitizeDoctorNote(change), "Doctor changes");
  }
  for (const info of params.infoNotes ?? []) {
    params.note(sanitizeDoctorNote(info), "Doctor info");
  }
  for (const warning of params.warningNotes ?? []) {
    params.note(sanitizeDoctorNote(warning), "Doctor warnings");
  }
}

// Repair-mode "Doctor changes" panels queue until the final candidate passes the
// same validation the atomic writer enforces: printing "Doctor changes" and then
// refusing the write would report repairs that never reached disk. Preview
// panels print immediately — they promise nothing.
type DoctorChangesPanelSink = {
  emit: (changeLines: ReadonlyArray<string>, options?: { sanitize?: boolean }) => void;
  drain: () => string[];
};

export function createDoctorChangesPanelSink(
  shouldRepair: boolean,
  note: (message: string, title?: string) => void,
): DoctorChangesPanelSink {
  const pending: string[] = [];
  return {
    emit: (changeLines, options = {}) => {
      if (changeLines.length === 0) {
        return;
      }
      const body = changeLines.join("\n");
      const message = options.sanitize ? sanitizeDoctorNote(body) : body;
      if (shouldRepair) {
        pending.push(message);
        return;
      }
      note(message, "Doctor changes preview");
    },
    drain: () => pending.splice(0),
  };
}
