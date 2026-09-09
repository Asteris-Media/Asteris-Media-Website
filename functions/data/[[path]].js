// Serve /data/<CODIGO>.json — primeiro da base de dados (KV), senão do ficheiro estático.
export async function onRequest(context) {
  const { params, env, request } = context;
  const parts = Array.isArray(params.path) ? params.path : [params.path];
  const file = (parts || []).join("/");
  const m = file.match(/^([A-Za-z0-9_-]{3,32})\.json$/);

  if (m && env.ASTERIS_KV) {
    const code = m[1].toUpperCase();
    const val = await env.ASTERIS_KV.get("page:" + code);
    if (val != null) {
      return new Response(val, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store",
          "access-control-allow-origin": "*"
        }
      });
    }
  }
  // fallback: ficheiro estático em /data/ (exemplos)
  return env.ASSETS.fetch(request);
}
