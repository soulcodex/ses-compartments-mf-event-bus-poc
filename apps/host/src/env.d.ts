// Ambient declarations for Rsbuild's resource query imports used in this app.
// `?raw` returns the file contents as a string; `?worker` returns a Worker
// constructor. These are resolved by Rsbuild at build time.

declare module "*?raw" {
  const content: string;
  export default content;
}

declare module "*?worker" {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}
