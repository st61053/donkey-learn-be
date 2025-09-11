1. **Načtení dat**

   * Vezmou se všechny tvoje soubory ve složce.
   * Z DB se natáhnou jejich chunky (už ořezané na `AI_CHUNK_TRIM_CHARS`).
   * Udělá se mapa `chunkId → fileId` (kvůli doplnění metadat od AI).

2. **Okna jen z jednoho souboru**

   * Chunky se **seskupí podle `fileId`**.
   * Pro každý soubor zvlášť běží `ChunkSelectorService.selectBestChunks(...)`, který z jeho chunků složí okna o velikosti `AI_WINDOW_SIZE`.
     (Žádné míchání víc souborů do jednoho okna.)

3. **Volání AI po souborech se stop-podmínkou**

   * Pro soubor posíláme jeho okna do `AiService.generateQuestions(...)` tak dlouho, **dokud nenasbíráme alespoň `topicCount` otázek** (nebo nedojdou okna).
   * Do promptu jde přepočtený mix přes `AI_PER_WINDOW_TARGET` (kolik otázek chceš z jedné dávky).
   * AI má zadání, ať přidá meta `s.c` (chunkId) a `s.f` (fileId). Když `s.f` chybí, **dopočítáme ho** z mapy `chunkId → fileId`.

4. **Filtrování a výběr pro topic test**

   * Z odpovědí z tohoto běhu bereme **jen otázky, kde `s.f == fileId`** daného souboru.
   * `pickByMixAndTake(...)` vybere podle `mix` (např. jen `mcq`) a omezí na `topicCount`.
   * Vznikne **topic test pro daný soubor** (pokud vyšlo ≥1 otázka).

5. **DB-friendly uložení + sanitizace textu**

   * Otázky se mapují do tvaru:

     * `type` (např. `mcq`), `text`, `choices`, `correct` / `truth` / …, `meta: { chunkId, fileId }`.
   * Před uložením čistíme texty: **odstraníme** “Podle úryvku …” a identifikátory “`(c:..., f:...)`”.
   * Test se uloží (archived=false).

6. **Finální test**

   * Současně sbíráme **globální pool všech otázek** (ze všech souborů a oken).
   * Po dojetí všech souborů z něj `pickByMixAndTake(...)` vybere `finalCount` a uloží jeden **finální test**.

7. **Progress & výsledky**

   * Websocket posílá průběžné hlášky (okna/soubor).
   * Výsledek vrátí seznam topic testů (kolik otázek se podařilo) + ID finálního testu.

