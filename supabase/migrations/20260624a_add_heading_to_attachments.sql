-- attachments テーブルに heading_deg 列を追加。
-- 写真の「撮影方向」（端末方位 0=北, 90=東 ... 359.999）を保存する。
-- 既存行は NULL のままで構わない（座標写真などには方向情報が無くてもよい）。
--
-- 何度流しても安全。

ALTER TABLE public.attachments
  ADD COLUMN IF NOT EXISTS heading_deg double precision;

-- 工区写真（entity_type='farm_photo'）で farm_id 単位の引きが速くなるよう
-- entity_id+entity_type の組み合わせインデックスを念のため追加（無ければ）。
CREATE INDEX IF NOT EXISTS idx_attachments_entity
  ON public.attachments (entity_type, entity_id);
