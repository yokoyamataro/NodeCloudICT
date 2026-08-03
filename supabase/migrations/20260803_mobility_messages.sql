-- ============================================================
-- モビリティ 指示 / 報告 / チャット 一元テーブル
--
-- 概要:
--   ・admin -> driver に「この車両でこのポイントに行け」の instruction を送る
--   ・driver は confirmation を返すと同時に vehicle_assignments が自動起動
--   ・driver が目的地から 100m 以内で arrival を送ると assignment.ended_at が入る
--   ・自由テキスト note を双方向にやり取り (チャット)
--
-- チャンネル:
--   ・direct:  管理者 <-> 特定ドライバー 1:1
--   ・project: 現場メンバー全員 (mobility_project_members) が見れる
--
-- 依存:
--   ・is_org_member(org_id) / is_admin_of_org(org_id) / is_site_owner()
--   ・is_org_member_of_mproject(project_id) / is_org_admin_of_mproject(project_id)
-- ============================================================

CREATE TABLE IF NOT EXISTS public.mobility_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- チャンネル
  channel_kind text NOT NULL CHECK (channel_kind IN ('direct','project')),
  channel_user_id    uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  channel_project_id uuid REFERENCES public.mobility_projects(id) ON DELETE CASCADE,

  -- 送信者
  sender_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  sender_role    text NOT NULL CHECK (sender_role IN ('admin','driver')),

  -- 種別
  message_kind text NOT NULL CHECK (message_kind IN
    ('instruction','confirmation','arrival','note')),

  body text,

  -- instruction ペイロード (driver が確認すると自動割当に使う)
  instruction_vehicle_id uuid REFERENCES public.vehicles(id) ON DELETE SET NULL,
  instruction_point_id   uuid REFERENCES public.mobility_project_points(id) ON DELETE SET NULL,

  -- instruction を確認/到着報告する際に元 instruction を指す
  parent_message_id uuid REFERENCES public.mobility_messages(id) ON DELETE CASCADE,

  read_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),

  CHECK ((channel_kind='direct'  AND channel_user_id    IS NOT NULL) OR
         (channel_kind='project' AND channel_project_id IS NOT NULL)),
  CHECK (message_kind <> 'instruction' OR instruction_point_id IS NOT NULL)
);

COMMENT ON TABLE public.mobility_messages IS
  '運行指示 / 到着報告 / 自由チャットを一元管理';

-- チャンネル別の時系列取得高速化
CREATE INDEX IF NOT EXISTS idx_mobility_messages_direct_time
  ON public.mobility_messages (channel_user_id, created_at DESC)
  WHERE channel_kind = 'direct';

CREATE INDEX IF NOT EXISTS idx_mobility_messages_project_time
  ON public.mobility_messages (channel_project_id, created_at DESC)
  WHERE channel_kind = 'project';

CREATE INDEX IF NOT EXISTS idx_mobility_messages_org_time
  ON public.mobility_messages (organization_id, created_at DESC);

-- 未読カウント用
CREATE INDEX IF NOT EXISTS idx_mobility_messages_unread
  ON public.mobility_messages (channel_user_id, read_at)
  WHERE read_at IS NULL AND channel_kind = 'direct';

-- ============================================================
-- RLS
-- ============================================================
ALTER TABLE public.mobility_messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "read_own_or_org" ON public.mobility_messages;
CREATE POLICY "read_own_or_org" ON public.mobility_messages
  FOR SELECT
  USING (
    public.is_site_owner()
    OR public.is_admin_of_org(organization_id)
    OR sender_user_id = auth.uid()
    OR (channel_kind = 'direct'  AND channel_user_id = auth.uid())
    OR (channel_kind = 'project' AND public.is_org_member_of_mproject(channel_project_id))
  );

-- INSERT はサーバー RPC 経由が基本だが、note に関しては直接 INSERT も許容。
-- 誰でも "自組織メンバー" として自分名義でメッセージを入れられる。
DROP POLICY IF EXISTS "insert_self_in_org" ON public.mobility_messages;
CREATE POLICY "insert_self_in_org" ON public.mobility_messages
  FOR INSERT
  WITH CHECK (
    sender_user_id = auth.uid()
    AND public.is_org_member(organization_id)
    AND (
      (channel_kind = 'direct'  AND channel_user_id IS NOT NULL)
      OR (channel_kind = 'project' AND public.is_org_member_of_mproject(channel_project_id))
    )
  );

-- UPDATE: read_at の更新のみ許容 (受信者 or admin)
DROP POLICY IF EXISTS "update_read_at" ON public.mobility_messages;
CREATE POLICY "update_read_at" ON public.mobility_messages
  FOR UPDATE
  USING (
    public.is_admin_of_org(organization_id)
    OR (channel_kind = 'direct'  AND channel_user_id = auth.uid())
    OR (channel_kind = 'project' AND public.is_org_member_of_mproject(channel_project_id))
  )
  WITH CHECK (
    public.is_admin_of_org(organization_id)
    OR (channel_kind = 'direct'  AND channel_user_id = auth.uid())
    OR (channel_kind = 'project' AND public.is_org_member_of_mproject(channel_project_id))
  );

-- DELETE: admin or 送信者
DROP POLICY IF EXISTS "delete_own_or_admin" ON public.mobility_messages;
CREATE POLICY "delete_own_or_admin" ON public.mobility_messages
  FOR DELETE
  USING (
    public.is_site_owner()
    OR public.is_admin_of_org(organization_id)
    OR sender_user_id = auth.uid()
  );

-- ============================================================
-- Realtime
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
    AND schemaname = 'public'
    AND tablename = 'mobility_messages'
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.mobility_messages';
  END IF;
END $$;

-- ============================================================
-- RPC: 指示送信 (admin → driver or project)
-- ============================================================
CREATE OR REPLACE FUNCTION public.mobility_send_instruction(
  p_organization_id uuid,
  p_channel_kind text,          -- 'direct' | 'project'
  p_channel_user_id uuid,       -- direct 時に必須
  p_channel_project_id uuid,    -- project 時に必須
  p_vehicle_id uuid,            -- 割当対象 (NULL 可 = 車両指定なし)
  p_point_id uuid,              -- 行き先 (必須)
  p_body text                   -- 補足メモ (NULL 可)
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id uuid;
BEGIN
  IF NOT (public.is_site_owner() OR public.is_admin_of_org(p_organization_id)) THEN
    RAISE EXCEPTION '指示送信権限がありません';
  END IF;

  IF p_point_id IS NULL THEN
    RAISE EXCEPTION '行き先ポイントは必須です';
  END IF;

  INSERT INTO public.mobility_messages (
    organization_id, channel_kind, channel_user_id, channel_project_id,
    sender_user_id, sender_role,
    message_kind, body,
    instruction_vehicle_id, instruction_point_id
  ) VALUES (
    p_organization_id, p_channel_kind, p_channel_user_id, p_channel_project_id,
    auth.uid(), 'admin',
    'instruction', p_body,
    p_vehicle_id, p_point_id
  ) RETURNING id INTO new_id;

  RETURN new_id;
END $$;

GRANT EXECUTE ON FUNCTION public.mobility_send_instruction(uuid,text,uuid,uuid,uuid,uuid,text)
  TO authenticated;

-- ============================================================
-- RPC: 指示確認 (driver → admin) - 自動で assignment を開始
-- 戻り値: 開始した assignment_id (NULL = 車両指定なしで assignment 作成せず)
-- ============================================================
CREATE OR REPLACE FUNCTION public.mobility_confirm_instruction(
  p_instruction_id uuid
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  inst public.mobility_messages%ROWTYPE;
  new_assignment_id uuid;
  existing_active_id uuid;
BEGIN
  SELECT * INTO inst FROM public.mobility_messages WHERE id = p_instruction_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION '指示が見つかりません';
  END IF;
  IF inst.message_kind <> 'instruction' THEN
    RAISE EXCEPTION 'この操作は instruction 専用です';
  END IF;

  -- direct 宛以外は本人が受信対象か確認 (project 宛はメンバーなら誰でも確認可)
  IF inst.channel_kind = 'direct' AND inst.channel_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'あなた宛ての指示ではありません';
  END IF;
  IF inst.channel_kind = 'project'
     AND NOT public.is_org_member_of_mproject(inst.channel_project_id) THEN
    RAISE EXCEPTION 'この現場のメンバーではありません';
  END IF;

  -- confirmation を記録
  INSERT INTO public.mobility_messages (
    organization_id, channel_kind, channel_user_id, channel_project_id,
    sender_user_id, sender_role,
    message_kind, parent_message_id
  ) VALUES (
    inst.organization_id, inst.channel_kind, inst.channel_user_id, inst.channel_project_id,
    auth.uid(), 'driver',
    'confirmation', inst.id
  );

  -- 車両指定がなければ assignment は作らず終了
  IF inst.instruction_vehicle_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- 既に別の車両で乗車中なら二重乗車を防ぐ
  SELECT id INTO existing_active_id
    FROM public.vehicle_assignments
    WHERE user_id = auth.uid() AND ended_at IS NULL
    LIMIT 1;
  IF existing_active_id IS NOT NULL THEN
    RAISE EXCEPTION '既に別の車両で乗車中です。降車してから再度確認してください';
  END IF;

  -- 車両が他人に使われていれば拒否
  IF EXISTS (
    SELECT 1 FROM public.vehicle_assignments
    WHERE vehicle_id = inst.instruction_vehicle_id AND ended_at IS NULL
  ) THEN
    RAISE EXCEPTION 'この車両は他のドライバーが使用中です';
  END IF;

  INSERT INTO public.vehicle_assignments (
    vehicle_id, user_id, destination_point_id, memo
  ) VALUES (
    inst.instruction_vehicle_id, auth.uid(), inst.instruction_point_id,
    '指示により自動割当'
  ) RETURNING id INTO new_assignment_id;

  RETURN new_assignment_id;
END $$;

GRANT EXECUTE ON FUNCTION public.mobility_confirm_instruction(uuid) TO authenticated;

-- ============================================================
-- RPC: 到着報告 - assignment を終了
-- 100m 判定はクライアント側で行う想定
-- ============================================================
CREATE OR REPLACE FUNCTION public.mobility_report_arrival(
  p_assignment_id uuid,
  p_instruction_id uuid   -- 元の instruction 参照 (NULL 可)
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  a public.vehicle_assignments%ROWTYPE;
  inst public.mobility_messages%ROWTYPE;
BEGIN
  SELECT * INTO a FROM public.vehicle_assignments WHERE id = p_assignment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'assignment が見つかりません';
  END IF;
  IF a.user_id <> auth.uid() THEN
    RAISE EXCEPTION 'あなたの assignment ではありません';
  END IF;
  IF a.ended_at IS NOT NULL THEN
    RAISE EXCEPTION '既に降車済みです';
  END IF;

  -- 到着メッセージを記録 (instruction 参照は任意)
  IF p_instruction_id IS NOT NULL THEN
    SELECT * INTO inst FROM public.mobility_messages WHERE id = p_instruction_id;
    IF FOUND THEN
      INSERT INTO public.mobility_messages (
        organization_id, channel_kind, channel_user_id, channel_project_id,
        sender_user_id, sender_role,
        message_kind, parent_message_id
      ) VALUES (
        inst.organization_id, inst.channel_kind, inst.channel_user_id, inst.channel_project_id,
        auth.uid(), 'driver',
        'arrival', inst.id
      );
    END IF;
  ELSE
    -- instruction 参照なしでも組織を辿ってメッセージ記録
    INSERT INTO public.mobility_messages (
      organization_id, channel_kind, channel_user_id,
      sender_user_id, sender_role, message_kind
    )
    SELECT v.organization_id, 'direct', auth.uid(),
           auth.uid(), 'driver', 'arrival'
      FROM public.vehicles v WHERE v.id = a.vehicle_id;
  END IF;

  -- assignment を終了
  UPDATE public.vehicle_assignments
    SET ended_at = now()
    WHERE id = p_assignment_id;
END $$;

GRANT EXECUTE ON FUNCTION public.mobility_report_arrival(uuid,uuid) TO authenticated;
