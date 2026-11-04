/** Images imported from the dashboard's code, which Bun's bundler turns into their URL. */
declare module "*.svg" {
  const url: string;

  export default url;
}
