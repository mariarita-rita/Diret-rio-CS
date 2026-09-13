-- Schema das trilhas de treinamento para clientes (Supabase / Postgres).
--
-- Referência apenas: NÃO é executado pelo app. Cole no SQL Editor do projeto
-- Supabase uma única vez, na criação do projeto (ou ao adicionar uma tabela
-- nova). O app só fala com essas tabelas via REST (PostgREST), com a
-- SUPABASE_SERVICE_ROLE_KEY — ver api/_lib/supabase.js.
--
-- Convenção de nomes em português, igual ao resto do repositório.

create table clientes (
  id uuid primary key default gen_random_uuid(),
  id_nucleo text not null unique,       -- chave que amarra o cliente entre ferramentas (ver api/_lib/clickup.js)
  cnpj text,
  nome text not null,
  produtos_ativos text[] not null default '{}',  -- espelha OUTROS_SRV do ClickUp (Carteira)
  clickup_task_id text,                 -- id da task na lista Carteira, para rastreabilidade do sync
  ativo boolean not null default true,  -- false = sumiu da Carteira num sync (não deleta, preserva histórico)
  sincronizado_em timestamptz not null default now(),
  criado_em timestamptz not null default now()
);
create index idx_clientes_cnpj on clientes (cnpj);

-- E-mails autorizados a logar (o ClickUp não tem campo de e-mail estruturado
-- na Carteira, então isso é mantido só aqui, cadastrado manualmente pelo admin).
create table clientes_emails (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references clientes(id) on delete cascade,
  email text not null unique,           -- único globalmente: senha é global, e-mail identifica o cliente
  criado_em timestamptz not null default now(),
  criado_por text                       -- nome/e-mail de quem cadastrou (auditoria)
);
create index idx_clientes_emails_cliente on clientes_emails (cliente_id);

-- Trilhas de treinamento. produtos é um array — uma trilha pode valer para
-- vários produtos, e um array VAZIO significa "geral" (aparece pra todo
-- cliente, independente do que ele ativou). Cada valor precisa bater com um
-- valor de OUTROS_SRV (ex: "Simplaz Ouro") ou do plano base (Gestor/Unique).
create table trilhas (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  descricao text,
  produtos text[] not null default '{}',
  ativa boolean not null default true,   -- arquivar preserva vídeos e histórico, só some da lista do cliente
  ordem integer not null default 0,
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);

-- Vídeos de cada trilha, na ordem de exibição.
create table trilha_videos (
  id uuid primary key default gen_random_uuid(),
  trilha_id uuid not null references trilhas(id) on delete cascade,
  titulo text not null,
  youtube_id text not null,             -- só o id de 11 caracteres, nunca a URL inteira
  ordem integer not null default 0,
  duracao_segundos integer,
  ativo boolean not null default true,   -- arquivar preserva o histórico de quem assistiu
  criado_em timestamptz not null default now()
);
create index idx_trilha_videos_trilha on trilha_videos (trilha_id, ordem);

-- Estado de visualização: uma linha por (e-mail, vídeo), sobrescrita a cada
-- atualização de progresso — não é um log de todas as sessões de reprodução.
create table video_visualizacoes (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references clientes(id) on delete cascade,
  email text not null,                  -- qual login assistiu (um cliente pode ter mais de um e-mail autorizado)
  trilha_video_id uuid not null references trilha_videos(id) on delete cascade,
  concluido boolean not null default false,
  percentual_maximo integer not null default 0,  -- maior % já atingido (gatilho de conclusão: 90%)
  concluido_em timestamptz,
  progresso_segundos integer not null default 0,  -- última posição conhecida, para retomar
  atualizado_em timestamptz not null default now(),
  unique (email, trilha_video_id)
);
create index idx_visualizacoes_cliente on video_visualizacoes (cliente_id);
create index idx_visualizacoes_video on video_visualizacoes (trilha_video_id);

-- RLS: o app só fala com estas tabelas usando a SUPABASE_SERVICE_ROLE_KEY, que
-- ignora RLS por definição — então isto não é exigido para o app funcionar.
-- Habilitar mesmo assim, SEM nenhuma política, é defesa em profundidade: se a
-- chave `anon` algum dia vazar ou for colada em algo client-side por engano,
-- RLS ligado sem políticas nega tudo por padrão, em vez de expor as tabelas
-- inteiras. Não afeta a service_role key, que continua enxergando tudo.
alter table clientes enable row level security;
alter table clientes_emails enable row level security;
alter table trilhas enable row level security;
alter table trilha_videos enable row level security;
alter table video_visualizacoes enable row level security;

-- MIGRAÇÃO (rodar só se a tabela `trilhas` já existir com a coluna `produto`
-- antiga, de um texto só — troca por `produtos`, um array, sem perder trilha
-- nenhuma: cada uma migra pro array de 1 item com o produto que já tinha).
alter table trilhas add column if not exists produtos text[] not null default '{}';
update trilhas set produtos = array[produto] where produto is not null and produto <> '' and produtos = '{}';
alter table trilhas drop column if exists produto;
drop index if exists idx_trilhas_produto;
