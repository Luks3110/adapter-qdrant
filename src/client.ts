import { v4, v5 } from "uuid";
import { QdrantClient } from "@qdrant/js-client-rest";
import {
  Account,
  Actor,
  GoalStatus,
  IDatabaseCacheAdapter,
  UUID,
  elizaLogger,
  RAGKnowledgeItem,
  DatabaseAdapter,
  Participant,
  type Memory,
  type Goal,
  type Relationship,
  type IAgentRuntime,
  type IDatabaseAdapter,
  type Plugin
} from "@elizaos/core";

// Declare the Adapter type
declare type Adapter = {
  init: (runtime: IAgentRuntime) => IDatabaseAdapter & IDatabaseCacheAdapter;
};

export class QdrantDatabaseAdapter
  extends DatabaseAdapter<QdrantClient>
  implements IDatabaseCacheAdapter
{
  declare db: QdrantClient;
  collectionName: string = "collection";
  qdrantV5UUIDNamespace: string = "00000000-0000-0000-0000-000000000000";
  cacheM: Map<string, string> = new Map<string, string>();
  vectorSize: number;
  constructor(url: string, apiKey: string, port: number, vectorSize: number) {
    super();
    elizaLogger.info("new Qdrant client...");
    this.db = new QdrantClient({
      url: url,
      apiKey: apiKey,
      port: port
    });
    this.vectorSize = vectorSize;
  }

  private preprocess(content: string): string {
    if (!content || typeof content !== "string") {
      elizaLogger.warn("Invalid input for preprocessing");
      return "";
    }
    const processedContent = content
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`.*?`/g, "")
      .replace(/#{1,6}\s*(.*)/g, "$1")
      .replace(/!\[(.*?)\]\(.*?\)/g, "$1")
      .replace(/\[(.*?)\]\(.*?\)/g, "$1")
      .replace(/(https?:\/\/)?(www\.)?([^\s]+\.[^\s]+)/g, "$3")
      .replace(/<@[!&]?\d+>/g, "")
      .replace(/<[^>]*>/g, "")
      .replace(/^\s*[-*_]{3,}\s*$/gm, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*/g, "")
      .replace(/\s+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/[^a-zA-Z0-9\s\-_./:?=&]/g, "")
      .trim();
    return processedContent;
  }

  async init() {
    const response = await this.db.getCollections();
    const collectionNames = response.collections.map(
      (collection) => collection.name
    );
    if (collectionNames.includes(this.collectionName)) {
      elizaLogger.info("Collection already exists.");
    } else {
      elizaLogger.info("create collection...");
      await this.db.createCollection(this.collectionName, {
        vectors: {
          size: this.vectorSize,
          distance: "Cosine"
        }
      });
    }
  }

  async createKnowledge(knowledge: RAGKnowledgeItem): Promise<void> {
    const metadata = knowledge.content.metadata || {};
    elizaLogger.info("Qdrant adapter createKnowledge id:", knowledge.id);
    await this.db.upsert(this.collectionName, {
      wait: true,
      points: [
        {
          id: this.buildQdrantID(knowledge.id), // the qdrant id must be a standard uuid
          vector: knowledge.embedding ? Array.from(knowledge.embedding) : [],
          payload: {
            agentId: metadata.isShared ? null : knowledge.agentId,
            content: {
              text: knowledge.content.text,
              metadata: metadata
            },
            createdAt: knowledge.createdAt || Date.now(),
            isMain: metadata.isMain || false,
            originalId: metadata.originalId || null,
            chunkIndex: metadata.chunkIndex || null,
            isShared: metadata.isShared || false
          }
        }
      ]
    });
  }

  async getKnowledge(params: {
    query?: string;
    id?: UUID;
    conversationContext?: string;
    limit?: number;
    agentId?: UUID;
  }): Promise<RAGKnowledgeItem[]> {
    elizaLogger.info("Qdrant adapter getKnowledge...", params.id);
    const rows = await this.db.retrieve(this.collectionName, {
      ids: params.id ? [params.id.toString()] : []
    });

    const results: RAGKnowledgeItem[] = rows.map((row) => {
      return {
        id: row.id.toString() as UUID,
        agentId: (row.payload?.agentId || "") as UUID,
        content: {
          text: String(row.payload?.description || ""),
          metadata: row.payload as { [key: string]: unknown }
        },
        embedding: row.vector
          ? Float32Array.from(row.vector as number[])
          : undefined,
        createdAt: row.payload?.createdAt as number
      };
    });
    return results;
  }

  async processFile(file: {
    path: string;
    content: string;
    type: "pdf" | "md" | "txt";
    isShared: boolean;
  }): Promise<void> {
    return Promise.resolve(undefined);
  }

  async removeKnowledge(id: UUID): Promise<void> {
    return Promise.resolve(undefined);
  }

  async searchKnowledge(params: {
    agentId: UUID;
    embedding: Float32Array | number[];
    match_threshold?: number;
    match_count?: number;
    searchText?: string;
  }): Promise<RAGKnowledgeItem[]> {
    const cacheKey = `${params.agentId}:${params.embedding.toString()}`;
    const cachedResult = await this.getCache({
      key: cacheKey,
      agentId: params.agentId
    });

    if (cachedResult) {
      return JSON.parse(cachedResult);
    }
    const rows = await this.db.search(this.collectionName, {
      vector: Array.from(params.embedding),
      with_vector: true
    });

    const results: RAGKnowledgeItem[] = rows.map((row) => {
      elizaLogger.info(
        "Qdrant adapter searchKnowledge id:",
        row.id.toString() as UUID
      );

      return {
        id: row.id.toString() as UUID,
        agentId: (row.payload?.agentId || "") as UUID,
        content: {
          text: String(row.payload?.description || ""),
          metadata: row.payload as { [key: string]: unknown }
        },
        embedding: row.vector
          ? Float32Array.from(row.vector as number[])
          : undefined,
        createdAt: row.payload?.createdAt as number,
        similarity: row.score || 0
      };
    });
    elizaLogger.debug("Qdrant adapter searchKnowledge results:", results);
    await this.setCache({
      key: cacheKey,
      agentId: params.agentId,
      value: JSON.stringify(results)
    });
    return results;
  }

  async addParticipant(userId: UUID, roomId: UUID): Promise<boolean> {
    return Promise.resolve(false);
  }

  async clearKnowledge(agentId: UUID, shared?: boolean): Promise<void> {
    return Promise.resolve(undefined);
  }

  async close(): Promise<void> {
    return Promise.resolve(undefined);
  }

  async countMemories(
    roomId: UUID,
    unique?: boolean,
    tableName?: string
  ): Promise<number> {
    return Promise.resolve(0);
  }

  async createAccount(account: Account): Promise<boolean> {
    return Promise.resolve(false);
  }

  async createGoal(goal: Goal): Promise<void> {
    return Promise.resolve(undefined);
  }

  async createMemory(
    memory: Memory,
    tableName: string,
    unique?: boolean
  ): Promise<void> {
    elizaLogger.debug("QdrantAdapter createMemory:", {
      memoryId: memory.id,
      embeddingLength: memory.embedding?.length,
      contentLength: memory.content?.text?.length
    });

    let isUnique = unique ?? true;
    if (memory.embedding) {
      const similarMemories = await this.searchMemoriesByEmbedding(
        memory.embedding,
        {
          tableName,
          roomId: memory.roomId,
          match_threshold: 0.95,
          count: 1
        }
      );
      isUnique = similarMemories.length === 0;
    }

    await this.db.upsert(this.collectionName, {
      wait: true,
      points: [
        {
          id: this.buildQdrantID(memory.id || v4()),
          vector: memory.embedding
            ? Array.from(memory.embedding)
            : new Array(this.vectorSize).fill(0),
          payload: {
            id: memory.id,
            type: tableName,
            content: memory.content,
            userId: memory.userId,
            roomId: memory.roomId,
            agentId: memory.agentId,
            unique: memory.unique ?? isUnique,
            createdAt: Date.now()
          }
        }
      ]
    });
  }

  async createRelationship(params: {
    userA: UUID;
    userB: UUID;
  }): Promise<boolean> {
    return Promise.resolve(false);
  }

  async createRoom(roomId?: UUID): Promise<UUID> {
    const newRoomId = roomId || v4();
    return newRoomId as UUID;
  }

  async getAccountById(userId: UUID): Promise<Account | null> {
    return null;
  }

  async getActorDetails(params: { roomId: UUID }): Promise<Actor[]> {
    return Promise.resolve([]);
  }

  async getCachedEmbeddings(params: {
    query_table_name: string;
    query_threshold: number;
    query_input: string;
    query_field_name: string;
    query_field_sub_name: string;
    query_match_count: number;
  }): Promise<{ embedding: number[]; levenshtein_score: number }[]> {
    return Promise.resolve([]);
  }

  async getGoals(params: {
    agentId: UUID;
    roomId: UUID;
    userId?: UUID | null;
    onlyInProgress?: boolean;
    count?: number;
  }): Promise<Goal[]> {
    return Promise.resolve([]);
  }

  async getMemories(params: {
    roomId: UUID;
    count?: number;
    unique?: boolean;
    tableName: string;
    agentId?: UUID;
    start?: number;
    end?: number;
  }): Promise<Memory[]> {
    if (!params.tableName) throw new Error("tableName is required");
    if (!params.roomId) throw new Error("roomId is required");

    const filter: any = {
      must: [
        { key: "type", match: { value: params.tableName } },
        { key: "roomId", match: { value: params.roomId } }
      ]
    };

    if (params.unique) {
      filter.must.push({
        key: "unique",
        match: { value: params.unique.toString() }
      });
    }

    if (params.agentId) {
      filter.must.push({ key: "agentId", match: { value: params.agentId } });
    }

    if (params.start || params.end) {
      const range: any = { key: "createdAt" };
      if (params.start) range.gte = params.start;
      if (params.end) range.lte = params.end;
      filter.must.push({ range });
    }

    const scrollResults = await this.db.scroll(this.collectionName, {
      limit: params.count || 100,
      filter,
      with_payload: true,
      with_vector: true
    });

    return (scrollResults.points || []).map((point) => ({
      id: point.payload.id as UUID,
      type: point.payload.type as string,
      content: point.payload.content as { text: string },
      embedding: point.vector ? Array.from(point.vector as number[]) : [],
      userId: point.payload.userId as UUID,
      roomId: point.payload.roomId as UUID,
      agentId: point.payload.agentId as UUID,
      unique: point.payload.unique as boolean,
      createdAt: point.payload.createdAt as number
    }));
  }

  async getMemoriesByRoomIds(params: {
    tableName: string;
    agentId: UUID;
    roomIds: UUID[];
  }): Promise<Memory[]> {
    return Promise.resolve([]);
  }

  async getMemoryById(id: UUID): Promise<Memory | null> {
    return null;
  }

  async getParticipantUserState(
    roomId: UUID,
    userId: UUID
  ): Promise<"FOLLOWED" | "MUTED" | null> {
    return null;
  }

  async getParticipantsForAccount(userId: UUID): Promise<Participant[]> {
    return Promise.resolve([]);
  }

  async getParticipantsForRoom(roomId: UUID): Promise<UUID[]> {
    return Promise.resolve([]);
  }

  async getRelationship(params: {
    userA: UUID;
    userB: UUID;
  }): Promise<Relationship | null> {
    return null;
  }

  async getRelationships(params: { userId: UUID }): Promise<Relationship[]> {
    return Promise.resolve([]);
  }

  async getRoom(roomId: UUID): Promise<UUID | null> {
    return null;
  }

  async getRoomsForParticipant(userId: UUID): Promise<UUID[]> {
    return Promise.resolve([]);
  }

  async getRoomsForParticipants(userIds: UUID[]): Promise<UUID[]> {
    return Promise.resolve([]);
  }

  async log(params: {
    body: { [p: string]: unknown };
    userId: UUID;
    roomId: UUID;
    type: string;
  }): Promise<void> {
    return Promise.resolve(undefined);
  }

  async removeAllGoals(roomId: UUID): Promise<void> {
    return Promise.resolve(undefined);
  }

  async removeAllMemories(roomId: UUID, tableName: string): Promise<void> {
    return Promise.resolve(undefined);
  }

  async removeGoal(goalId: UUID): Promise<void> {
    return Promise.resolve(undefined);
  }

  async removeMemory(memoryId: UUID, tableName: string): Promise<void> {
    return Promise.resolve(undefined);
  }

  async removeParticipant(userId: UUID, roomId: UUID): Promise<boolean> {
    return Promise.resolve(false);
  }

  async removeRoom(roomId: UUID): Promise<void> {
    return Promise.resolve(undefined);
  }

  async searchMemories(params: {
    tableName: string;
    agentId: UUID;
    roomId: UUID;
    embedding: number[];
    match_threshold: number;
    match_count: number;
    unique: boolean;
  }): Promise<Memory[]> {
    const searchResults = await this.db.search(this.collectionName, {
      vector: Array.from(params.embedding),
      limit: params.match_count,
      score_threshold: params.match_threshold,
      filter: {
        must: [
          { key: "type", match: { value: params.tableName } },
          { key: "roomId", match: { value: params.roomId } },
          { key: "agentId", match: { value: params.agentId } },
          ...(params.unique
            ? [{ key: "unique", match: { value: params.unique.toString() } }]
            : [])
        ]
      },
      with_payload: true,
      with_vector: true
    });

    return searchResults.map((result) => ({
      id: result.payload.id as UUID,
      type: result.payload.type as string,
      content: result.payload.content as { text: string },
      embedding: result.vector ? Array.from(result.vector as number[]) : [],
      userId: result.payload.userId as UUID,
      roomId: result.payload.roomId as UUID,
      agentId: result.payload.agentId as UUID,
      unique: result.payload.unique as boolean,
      createdAt: result.payload.createdAt as number,
      similarity: result.score
    }));
  }

  async searchMemoriesByEmbedding(
    embedding: number[],
    params: {
      match_threshold?: number;
      count?: number;
      roomId?: UUID;
      agentId?: UUID;
      unique?: boolean;
      tableName: string;
    }
  ): Promise<Memory[]> {
    elizaLogger.debug("Incoming vector:", {
      length: embedding.length,
      sample: embedding.slice(0, 5),
      isArray: Array.isArray(embedding),
      allNumbers: embedding.every((n) => typeof n === "number")
    });

    // Validate embedding dimension
    if (embedding.length !== this.vectorSize) {
      throw new Error(
        `Invalid embedding dimension: expected ${this.vectorSize}, got ${embedding.length}`
      );
    }

    // Clean and normalize the vector
    const cleanVector = embedding.map((n) => {
      if (!Number.isFinite(n)) return 0;
      return Number(n.toFixed(6));
    });

    elizaLogger.debug("Vector debug:", {
      originalLength: embedding.length,
      cleanLength: cleanVector.length,
      sample: cleanVector.slice(0, 5)
    });

    // Build filter conditions
    const filter: any = {
      must: [{ key: "type", match: { value: params.tableName } }]
    };

    if (params.unique) {
      filter.must.push({
        key: "unique",
        match: { value: params.unique.toString() }
      });
    }

    if (params.agentId) {
      filter.must.push({ key: "agentId", match: { value: params.agentId } });
    }

    if (params.roomId) {
      filter.must.push({ key: "roomId", match: { value: params.roomId } });
    }

    // Perform the search
    const searchResults = await this.db.search(this.collectionName, {
      vector: cleanVector,
      limit: params.count || 10,
      score_threshold: params.match_threshold || 0,
      filter,
      with_payload: true,
      with_vector: true
    });

    elizaLogger.debug("Search results:", {
      count: searchResults.length,
      firstScore: searchResults[0]?.score
    });

    return searchResults.map((result) => ({
      id: result.payload.id as UUID,
      type: result.payload.type as string,
      content: result.payload.content as { text: string },
      embedding: result.vector ? Array.from(result.vector as number[]) : [],
      userId: result.payload.userId as UUID,
      roomId: result.payload.roomId as UUID,
      agentId: result.payload.agentId as UUID,
      unique: result.payload.unique as boolean,
      createdAt: result.payload.createdAt as number,
      similarity: result.score || 0
    }));
  }

  async setParticipantUserState(
    roomId: UUID,
    userId: UUID,
    state: "FOLLOWED" | "MUTED" | null
  ): Promise<void> {
    return Promise.resolve(undefined);
  }

  async updateGoal(goal: Goal): Promise<void> {
    return Promise.resolve(undefined);
  }

  async updateGoalStatus(params: {
    goalId: UUID;
    status: GoalStatus;
  }): Promise<void> {
    return Promise.resolve(undefined);
  }

  getMemoriesByIds(memoryIds: UUID[], tableName?: string): Promise<Memory[]> {
    throw new Error("Method not implemented.");
  }

  async getCache(params: {
    key: string;
    agentId: UUID;
  }): Promise<string | undefined> {
    let key = this.buildKey(params.agentId, params.key);
    let result = this.cacheM.get(key);
    return result;
  }

  async setCache(params: {
    key: string;
    agentId: UUID;
    value: string;
  }): Promise<boolean> {
    this.cacheM.set(this.buildKey(params.agentId, params.key), params.value);
    return true;
  }

  async deleteCache(params: { key: string; agentId: UUID }): Promise<boolean> {
    const key = this.buildKey(params.agentId, params.key);
    return this.cacheM.delete(key);
  }

  private buildKey(agentId: UUID, key: string): string {
    return `${agentId}:${key}`;
  }

  private buildQdrantID(id: string): string {
    return v5(id, this.qdrantV5UUIDNamespace);
  }
}

export const qdrantDatabaseAdapter: Adapter = {
  init: (runtime: IAgentRuntime) => {
    const QDRANT_URL = runtime.getSetting("QDRANT_URL");
    const QDRANT_KEY = runtime.getSetting("QDRANT_KEY");
    const QDRANT_PORT = runtime.getSetting("QDRANT_PORT");
    const QDRANT_VECTOR_SIZE = runtime.getSetting("QDRANT_VECTOR_SIZE");

    if (QDRANT_URL && QDRANT_KEY && QDRANT_PORT && QDRANT_VECTOR_SIZE) {
      elizaLogger.info("Initializing Qdrant adapter...");
      const db = new QdrantDatabaseAdapter(
        QDRANT_URL,
        QDRANT_KEY,
        Number(QDRANT_PORT),
        Number(QDRANT_VECTOR_SIZE)
      );
      return db;
    } else {
      throw new Error(
        "QDRANT_URL, QDRANT_KEY, QDRANT_PORT, and QDRANT_VECTOR_SIZE are not set"
      );
    }
  }
};
