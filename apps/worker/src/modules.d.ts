// Wrangler bundles .sql and .html files as text modules by default.
declare module "*.sql" {
  const sql: string;
  export default sql;
}

declare module "*.html" {
  const html: string;
  export default html;
}
