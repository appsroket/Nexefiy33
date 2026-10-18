// Embedding model for knowledge retrieval (ADR-008). The vector dimension is
// fixed in the database (knowledge_chunks.embedding vector(1024)); changing
// the model or dimension requires a migration and re-embedding every chunk.

export const EMBEDDING_PROVIDER = 'voyage'
export const EMBEDDING_MODEL = 'voyage-4'
export const EMBEDDING_DIMENSIONS = 1024
export const EMBEDDING_API_URL = 'https://api.voyageai.com/v1/embeddings'
