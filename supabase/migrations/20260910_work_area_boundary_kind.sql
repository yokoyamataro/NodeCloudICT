-- 地番 (境界測量の 画地) に 「仮境界」 と 「確定境界」 の 2 系統 を 持たせる。
--
-- 同じ 地番 でも、地図XML や 現況測量 から 起こした 暫定の 形 (仮境界) と、
-- 立会・確定測量 の 結果 (確定境界) は 別物 として 両方 残したい。
-- design_work_areas の 行 を 分けて 持ち、この列 で どちら かを 区別 する。
--
--   provisional … 仮境界 (既定)。 地図XML / JPGIS.XML からの 取込 は こちら
--   confirmed   … 確定境界。 SIM 取込 で 明示的に 選んだ ときだけ
--
-- 既存行 は すべて 仮境界 として 扱う (default で 埋まる)。

alter table public.design_work_areas
  add column if not exists boundary_kind text not null default 'provisional';

alter table public.design_work_areas
  drop constraint if exists design_work_areas_boundary_kind_check;

alter table public.design_work_areas
  add constraint design_work_areas_boundary_kind_check
  check (boundary_kind in ('provisional', 'confirmed'));

comment on column public.design_work_areas.boundary_kind is
  '境界の 種類: provisional=仮境界 / confirmed=確定境界。境界測量 (work_type=boundary_survey) 以外は provisional 固定';

-- 工区 + 種類 での 絞り込み を 効かせる
create index if not exists design_work_areas_farm_boundary_kind_idx
  on public.design_work_areas (farm_id, boundary_kind);
