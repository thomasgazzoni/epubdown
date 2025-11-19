import { SQLiteDB } from "@hayeah/sqlite-browser";
import { tswire } from "tswire";
import { CommandPaletteStore } from "../../command/CommandPaletteStore";
import type { AppCtx, AppEventSystem, AppLayers } from "../app/context";
import { EventSystem } from "../events/EventSystem";
import { BookLibraryStore } from "../stores/BookLibraryStore";
import { ReaderStore } from "../stores/ReaderStore";
import { RootStore } from "../stores/RootStore";
import { ReaderTemplateContext } from "../templates/ReaderTemplateContext";
import { type ReaderTemplates, parseTemplates } from "../templates/Template";
// @ts-ignore - raw import
import globalTemplatesRaw from "../templates/reader.global.templates.md.txt?raw";
// @ts-ignore - raw import
import selectionTemplatesRaw from "../templates/reader.selection.templates.md.txt?raw";
// @ts-ignore - raw import
import multipleChaptersTemplatesRaw from "../templates/reader.multiple-chapters.templates.md.txt?raw";
import { BlobStore } from "./BlobStore";
import { BookDatabase } from "./BookDatabase";
import { runMigrations } from "./runMigrations";

export interface StorageConfig {
  dbName: string;
  blobStoreName: string;
}

export function provideStorageConfig(): StorageConfig {
  return {
    dbName: "epub",
    blobStoreName: "epub-blob",
  };
}

/**
 * Create a new database instance with migrations applied.
 * Each call creates a fresh database connection.
 */
export async function getDb(dbName = "epubdown"): Promise<SQLiteDB> {
  const db = await SQLiteDB.open(dbName);
  await runMigrations(db);
  return db;
}

export async function provideSQLiteDB(cfg: StorageConfig): Promise<SQLiteDB> {
  return getDb(cfg.dbName);
}

export async function provideBlobStore(cfg: StorageConfig): Promise<BlobStore> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(cfg.blobStoreName, 1);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(cfg.blobStoreName)) {
        db.createObjectStore(cfg.blobStoreName);
      }
    };
  });

  return new BlobStore(db, {
    dbName: cfg.blobStoreName,
    storeName: cfg.blobStoreName,
  });
}

export async function provideBookLibraryStore(
  blobStore: BlobStore,
  bookDb: BookDatabase,
  sqliteDb: SQLiteDB,
  eventSystem: AppEventSystem,
): Promise<BookLibraryStore> {
  const store = new BookLibraryStore(blobStore, bookDb, sqliteDb, eventSystem);
  await store.loadBooks();
  return store;
}

export function provideEventSystem(): AppEventSystem {
  const system = new EventSystem();
  return system;
}

export function provideReaderTemplates(): ReaderTemplates {
  return {
    selection: parseTemplates(selectionTemplatesRaw),
    global: parseTemplates(globalTemplatesRaw),
    multipleChapters: parseTemplates(multipleChaptersTemplatesRaw),
  };
}

export function provideReaderTemplateContext(
  reader: ReaderStore,
  palette: CommandPaletteStore,
): ReaderTemplateContext {
  return new ReaderTemplateContext(reader, palette);
}

export function initRootStore(cfg: StorageConfig): RootStore {
  tswire([
    provideStorageConfig,
    provideSQLiteDB,
    provideBlobStore,
    BookDatabase,
    provideEventSystem,
    provideReaderTemplates,
    ReaderStore,
    provideBookLibraryStore,
    CommandPaletteStore,
    RootStore,
  ]);
  return null as any;
}
