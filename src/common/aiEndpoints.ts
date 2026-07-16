/**
 * Derive an OpenAI-compatible embeddings endpoint from a configured
 * chat/completions endpoint. Pure helper shared by dbindex embeddings
 * and the AI assistant configuration.
 */
export function getEmbeddingsEndpoint(configuredEndpoint: string): string {
  if (!configuredEndpoint) {
    return '';
  }
  let endpoint = configuredEndpoint.trim();
  if (endpoint.endsWith('/chat/completions')) {
    return endpoint.replace(/\/chat\/completions$/, '/embeddings');
  }
  endpoint = endpoint.replace(/\/$/, '');
  if (endpoint.endsWith('/v1')) {
    return endpoint + '/embeddings';
  }
  return endpoint + '/v1/embeddings';
}
