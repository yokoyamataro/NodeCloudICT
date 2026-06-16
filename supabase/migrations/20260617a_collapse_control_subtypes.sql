-- 旧点種コード 'existing_control' / 'new_control' を 'control' に統合する。
--
-- UI 側からは 既設基準点 / 新設基準点 の区別を廃止し、両者とも単一の
-- 「基準点」(coordinate_type = 'control') として扱う。
-- 既存行は本 SQL で永続的に書き換える。
--
-- design_coordinates.coordinate_type は TEXT 制約なしなので、UPDATE のみで OK。
-- 何度流しても安全（既に置換済みなら 0 行が更新される）。

UPDATE public.design_coordinates
   SET coordinate_type = 'control'
 WHERE coordinate_type IN ('existing_control', 'new_control');

-- プロジェクトのカスタム点種一覧側にも同名のコードが残っていれば消す
-- （UI で点種選択肢に出る原因になるため）。
DELETE FROM public.coordinate_point_types
 WHERE code IN ('existing_control', 'new_control');
