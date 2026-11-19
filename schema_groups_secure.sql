-- =====================================================================
-- Student Wallet: Nhóm & Chia sẻ + Blockchain (bản bảo mật)
-- Chạy toàn bộ file trong Supabase > SQL Editor > Run.
-- File này chạy lại nhiều lần được (idempotent) và không xóa dữ liệu.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. BẢNG (giữ nguyên các bảng bạn đã tạo, bổ sung cột còn thiếu)
-- ---------------------------------------------------------------------
create table if not exists public.user_profiles (
  id uuid references auth.users on delete cascade primary key,
  user_code text unique not null,
  full_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.groups (
  id uuid default gen_random_uuid() primary key,
  group_code text unique not null,
  name text not null,
  owner_id uuid references auth.users on delete cascade not null,
  created_at timestamptz not null default now()
);

create table if not exists public.group_members (
  id uuid default gen_random_uuid() primary key,
  group_id uuid references public.groups on delete cascade not null,
  user_id uuid references auth.users on delete cascade not null,
  joined_at timestamptz not null default now(),
  unique (group_id, user_id)
);
-- Code app đọc/ghi cột can_edit (quyền sửa), bảng cũ chưa có
alter table public.group_members add column if not exists can_edit boolean not null default false;

create table if not exists public.group_expenses (
  id uuid default gen_random_uuid() primary key,
  group_id uuid references public.groups on delete cascade not null,
  user_id uuid references auth.users on delete set null,   -- người mua
  member_name text,
  spent_on date not null,
  shop text not null,
  category text not null,
  amount bigint not null check (amount > 0),
  is_paid boolean not null default true,
  edit_count int not null default 0 check (edit_count between 0 and 3),
  items jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);
alter table public.group_expenses add column if not exists member_name text;
alter table public.group_expenses add column if not exists is_paid boolean not null default true;
alter table public.group_expenses add column if not exists edit_count int not null default 0;
alter table public.group_expenses add column if not exists items jsonb not null default '[]'::jsonb;
create index if not exists group_expenses_group_idx on public.group_expenses (group_id, spent_on desc);

create table if not exists public.group_budgets (
  group_id uuid references public.groups on delete cascade not null,
  category text not null,
  amount bigint not null check (amount >= 0),
  color text,
  threshold int not null default 80 check (threshold between 50 and 100),
  primary key (group_id, category)
);
alter table public.group_budgets add column if not exists color text;
alter table public.group_budgets add column if not exists threshold int not null default 80;

-- ---------------------------------------------------------------------
-- 2. HÀM TRỢ GIÚP (security definer để policy không bị đệ quy)
-- ---------------------------------------------------------------------
create or replace function public.is_group_owner(gid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.groups g where g.id = gid and g.owner_id = (select auth.uid()));
$$;

create or replace function public.is_group_member(gid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_group_owner(gid)
      or exists (select 1 from public.group_members m where m.group_id = gid and m.user_id = (select auth.uid()));
$$;

create or replace function public.can_edit_group(gid uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select public.is_group_owner(gid)
      or exists (select 1 from public.group_members m
                 where m.group_id = gid and m.user_id = (select auth.uid()) and m.can_edit);
$$;

revoke execute on function public.is_group_owner(uuid), public.is_group_member(uuid), public.can_edit_group(uuid) from public, anon;
grant  execute on function public.is_group_owner(uuid), public.is_group_member(uuid), public.can_edit_group(uuid) to authenticated;

-- ---------------------------------------------------------------------
-- 3. RLS: xóa policy cũ quá rộng (using true / with check true) rồi tạo lại
-- ---------------------------------------------------------------------
alter table public.user_profiles  enable row level security;
alter table public.groups         enable row level security;
alter table public.group_members  enable row level security;
alter table public.group_expenses enable row level security;
alter table public.group_budgets  enable row level security;

drop policy if exists "Cho phép xem user_profiles" on public.user_profiles;
drop policy if exists "Cho phép cập nhật user_profiles của chính mình" on public.user_profiles;
drop policy if exists "Cho phép tạo user_profiles" on public.user_profiles;
drop policy if exists "profiles_select" on public.user_profiles;
drop policy if exists "profiles_insert" on public.user_profiles;
drop policy if exists "profiles_update" on public.user_profiles;
drop policy if exists "Thành viên nhóm xem được groups" on public.groups;
drop policy if exists "Chủ nhóm tạo group" on public.groups;
drop policy if exists "Xem group_members" on public.group_members;
drop policy if exists "Thêm thành viên vào nhóm" on public.group_members;
drop policy if exists "Xóa thành viên khỏi nhóm" on public.group_members;

-- user_profiles: người đã đăng nhập xem được (app cần tra mã riêng để thêm thành viên)
create policy "profiles_select" on public.user_profiles for select to authenticated using (true);
create policy "profiles_insert" on public.user_profiles for insert to authenticated with check ((select auth.uid()) = id);
create policy "profiles_update" on public.user_profiles for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- groups: người đã đăng nhập tìm được nhóm theo mã; chỉ chủ nhóm sửa/xóa
drop policy if exists "groups_select" on public.groups;
drop policy if exists "groups_insert" on public.groups;
drop policy if exists "groups_update" on public.groups;
drop policy if exists "groups_delete" on public.groups;
create policy "groups_select" on public.groups for select to authenticated using (true);
create policy "groups_insert" on public.groups for insert to authenticated with check (owner_id = (select auth.uid()));
create policy "groups_update" on public.groups for update to authenticated
  using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
create policy "groups_delete" on public.groups for delete to authenticated using (owner_id = (select auth.uid()));

-- group_members
drop policy if exists "gm_select" on public.group_members;
drop policy if exists "gm_insert" on public.group_members;
drop policy if exists "gm_update" on public.group_members;
drop policy if exists "gm_delete" on public.group_members;
create policy "gm_select" on public.group_members for select to authenticated
  using (user_id = (select auth.uid()) or public.is_group_member(group_id));
-- Chủ nhóm thêm ai cũng được; người khác chỉ tự tham gia và KHÔNG được tự cấp quyền sửa
create policy "gm_insert" on public.group_members for insert to authenticated
  with check (public.is_group_owner(group_id) or (user_id = (select auth.uid()) and can_edit = false));
create policy "gm_update" on public.group_members for update to authenticated
  using (public.is_group_owner(group_id)) with check (public.is_group_owner(group_id));
-- Chủ nhóm xóa thành viên; thành viên tự rời nhóm
create policy "gm_delete" on public.group_members for delete to authenticated
  using (public.is_group_owner(group_id) or user_id = (select auth.uid()));

-- group_expenses: thành viên xem; chủ nhóm và người có can_edit được ghi
drop policy if exists "gx_select" on public.group_expenses;
drop policy if exists "gx_insert" on public.group_expenses;
drop policy if exists "gx_update" on public.group_expenses;
drop policy if exists "gx_delete" on public.group_expenses;
create policy "gx_select" on public.group_expenses for select to authenticated using (public.is_group_member(group_id));
create policy "gx_insert" on public.group_expenses for insert to authenticated with check (public.can_edit_group(group_id));
create policy "gx_update" on public.group_expenses for update to authenticated
  using (public.can_edit_group(group_id)) with check (public.can_edit_group(group_id));
create policy "gx_delete" on public.group_expenses for delete to authenticated using (public.can_edit_group(group_id));

-- group_budgets
drop policy if exists "gb_select" on public.group_budgets;
drop policy if exists "gb_write" on public.group_budgets;
create policy "gb_select" on public.group_budgets for select to authenticated using (public.is_group_member(group_id));
create policy "gb_write" on public.group_budgets for all to authenticated
  using (public.can_edit_group(group_id)) with check (public.can_edit_group(group_id));

-- ---------------------------------------------------------------------
-- 4. GIỚI HẠN SỬA 3 LẦN Ở PHÍA SERVER (không thể vượt bằng cách gọi API)
--    Khi đổi cửa hàng/ngày/số tiền/danh mục: edit_count phải tăng đúng 1 và còn dưới 3.
-- ---------------------------------------------------------------------
create or replace function public.enforce_edit_limit() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.edit_count < old.edit_count then
    raise exception 'edit_count không được giảm';
  end if;
  if (new.shop, new.spent_on, new.category, new.amount)
     is distinct from (old.shop, old.spent_on, old.category, old.amount) then
    if old.edit_count >= 3 then
      raise exception 'Hóa đơn đã hết lượt sửa (3/3)';
    end if;
    if new.edit_count <> old.edit_count + 1 then
      raise exception 'Mỗi lần sửa phải tăng edit_count đúng 1';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists expenses_edit_limit on public.expenses;
create trigger expenses_edit_limit before update on public.expenses
  for each row execute function public.enforce_edit_limit();

drop trigger if exists group_expenses_edit_limit on public.group_expenses;
create trigger group_expenses_edit_limit before update on public.group_expenses
  for each row execute function public.enforce_edit_limit();

-- ---------------------------------------------------------------------
-- 5. BLOCKCHAIN (2 đoạn bạn đã soạn trong tab "Contract" + cột seal cho nhóm)
--    Lưu ý: code hiện tại chưa dùng các cột này, nó đang nhét seal vào group_expenses.items.
-- ---------------------------------------------------------------------
alter table public.expenses
  add column if not exists avax_tx_hash text,
  add column if not exists receipt_sha256 text,
  add column if not exists onchain_request_id integer;

alter table public.profiles add column if not exists wallet_address text;

alter table public.group_expenses add column if not exists avax_seal jsonb;

-- ---------------------------------------------------------------------
-- 6. VÍ CỦA THÀNH VIÊN + ĐỀ NGHỊ HOÀN TỪ QUỸ
--    wallet_address: ví nhận tiền hoàn (người dùng tự nhập, chỉ sửa được của chính mình
--    nhờ policy profiles_update ở trên). avax_reimburse: thông tin đề nghị hoàn trên chain.
-- ---------------------------------------------------------------------
alter table public.user_profiles add column if not exists wallet_address text;
alter table public.user_profiles drop constraint if exists user_profiles_wallet_format;
alter table public.user_profiles add constraint user_profiles_wallet_format
  check (wallet_address is null or wallet_address ~ '^0x[0-9a-fA-F]{40}$');

alter table public.group_expenses add column if not exists avax_reimburse jsonb;
