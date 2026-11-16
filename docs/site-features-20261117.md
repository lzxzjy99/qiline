# Website feature work

User priority: finish the existing website's imported test-game replay and invitation-code online play before further AI development. Publish to the same public Site.

Site project_id: appgprj_6ad6f590bd4881919921299fa305f236
Existing URL: https://qiline-rebuild.xuanxliu.chatgpt.site
Opened source commit: d242323831c4960ec169370cc00d74c4e0a580c7
Checkout: C:\Users\lzx21\Documents\schedule\qiline-site-live-20261117\.sites-checkout

The original research project in schedule/qiline-p55-source is separate and frozen for a real 40-game formal AI acceptance run. Do not modify its files. Its formal worker lease identifies the running process; source and weights are frozen there. Website AI/core are unchanged product 0.5.11.

Implemented source: server/rooms.mjs (D1-backed atomic room revisions, seat tokens, command receipts, consent undo-two/cancel, resign and reconnect presence); server/index.mjs (Worker static assets and API); apps/web/online.html + features/online.mjs; test-records.html + records modules (local IndexedDB import, original envelope checksum and official replay, snapshots, move timing, export); shared board/UI helpers; tools/export-test-records.mjs reads local result files without running any search.

Hosting changes: static removed; d1 binding DB, r2 null. Drizzle schema-only initial migration generated under drizzle/. No tables are created in requests. Existing frontend assets are embedded into a self-contained Worker through scripts/build-hosted.mjs + esbuild. Preview uses wrangler.preview.json, port 4174, local D1.

Dependencies installed by Sites install helper: drizzle-kit, drizzle-orm, esbuild, wrangler. Native install scripts were not approved; db generation already worked. Do not force npm audit fixes or change host lifecycle policy without a concrete need.

Completed: homepage links and manual updated; 8 server/replay tests passed; hosted build and frozen core/AI byte checks passed; local D1 migration applied once. Browser QA imported 8 real games (7 candidate wins, 1 loss), retained them after refresh, replayed the final five-confirmation step, and filtered losses. Two independent player tabs verified opening, color selection, move synchronization, consent undo across color selection, identity recovery after refresh, locked moves during server outage, and automatic recovery with the same persisted database. Reconnect status notice now updates on successful recovery.

Remaining: publish through the Sites source helper and verify production room service. No credentials are stored in this document or repository. The 8-game development records are not the formal 40-game AI acceptance result.

Source helper Git operations need the approved escalated execution, because the normal environment cannot reach the source remote. This checkout was initialized by that mode, avoiding ownership mismatches. Preserve the earlier failed empty source workspace qiline-web-features-20261117; it has no user implementation.
