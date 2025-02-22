import { qdrantDatabaseAdapter } from "./client";
import { QdrantDatabaseAdapter } from "./client";

const qdrantPlugin = {
  name: "qdrant",
  description: "Qdrant database adapter plugin",
  adapters: [qdrantDatabaseAdapter]
};

export default qdrantPlugin;

export { QdrantDatabaseAdapter };
