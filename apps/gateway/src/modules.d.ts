// The Text module rule in wrangler.toml imports a shell script as its text.
declare module "*.sh" {
  const text: string;
  export default text;
}
