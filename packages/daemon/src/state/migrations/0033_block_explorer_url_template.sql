-- Configurable block explorer URL template (issue #22).
-- Used by the dashboard to turn block heights/hashes into clickable
-- links (Ocean panel "last pool block", Hashrate chart cube tooltips).
-- `{hash}` and `{height}` are both substituted if present. Default is
-- mempool.space so fresh installs get a working link without any
-- config step.

ALTER TABLE config
  ADD COLUMN block_explorer_url_template TEXT
  NOT NULL DEFAULT 'https://mempool.space/block/{hash}';
