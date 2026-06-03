export type LogEntry = {
  source: string;
  message: string;
  timestamp: number;
};

export type LogSink = (entry: LogEntry) => void;

const sinks: LogSink[] = [];

export function addLogSink(sink: LogSink): void {
  sinks.push(sink);
}

function emit(source: string, message: string): void {
  const entry: LogEntry = { source, message, timestamp: Date.now() };
  console.log(`[${source}] ${message}`);
  for (const sink of sinks) {
    try { sink(entry); } catch {}
  }
}

export function makeLogger(name: string) {
  return harden({
    info(...args: unknown[]) {
      emit(name, args.map(String).join(" "));
    },
    error(...args: unknown[]) {
      emit(name, args.map(String).join(" "));
    },
  });
}

export const hostLogger = {
  info(message: string) { emit("host", message); },
  error(message: string) { emit("host", message); },
};
