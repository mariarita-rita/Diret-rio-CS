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
  nota text,                            -- texto livre exibido junto do vídeo (ex: link pra base de conhecimento)
  atividade_titulo text,                -- ex: "Emitir uma nota no Gestor" — autodeclarada, sem aprovação
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

-- ── Gamificação ─────────────────────────────────────────────────────────

-- Atividade prática de um vídeo marcada como concluída — autodeclarada,
-- sem aprovação (mesmo princípio de "confiar no que o cliente diz" da nota).
create table atividades_concluidas (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references clientes(id) on delete cascade,
  email text not null,
  trilha_video_id uuid not null references trilha_videos(id) on delete cascade,
  concluida_em timestamptz not null default now(),
  unique (email, trilha_video_id)
);
create index idx_atividades_cliente on atividades_concluidas (cliente_id);

-- Catálogo de "gatilhos" de pontos (o QUE precisa acontecer), cadastrado pelo
-- admin. Não tem pontuação própria — quanto vale cada regra é definido por
-- PRÊMIO em premio_criterios (a mesma regra pode valer pontuações diferentes
-- em prêmios diferentes: "Já uso o Waipe" pode valer 15 pts pro Ingresso do
-- Camp e não entrar no Certificado, por exemplo).
create table pontos_regras (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  tipo text not null,                    -- 'automatica' | 'autodeclarada' | 'pendente_aprovacao'
  criterio_produtos text[] not null default '{}', -- só usado por 'automatica': satisfaz se produtos_ativos intersecta
  pede_identificacao boolean not null default false, -- pede e-mail/CPF-CNPJ da inscrição (ex: ingresso do Camp)
  ativa boolean not null default true,
  ordem integer not null default 0,
  criado_em timestamptz not null default now()
);

-- Um evento por (cliente, regra) — só existe para regras autodeclarada/
-- pendente_aprovacao (regra automática nunca gera linha aqui, é computada
-- ao vivo). autodeclarada nasce com status='aprovado'; pendente_aprovacao
-- nasce 'pendente' e só conta ponto depois que a equipe aprovar.
create table pontos_eventos (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references clientes(id) on delete cascade,
  email text not null,
  regra_id uuid not null references pontos_regras(id) on delete cascade,
  status text not null default 'pendente', -- 'pendente' | 'aprovado' | 'rejeitado'
  identificacao text,                    -- e-mail/CPF-CNPJ informado, quando a regra pede
  observacao text,
  criado_em timestamptz not null default now(),
  revisado_em timestamptz,
  revisado_por text,
  unique (email, regra_id)
);
create index idx_pontos_eventos_status on pontos_eventos (status);
create index idx_pontos_eventos_cliente on pontos_eventos (cliente_id);

-- Prêmios trocáveis por pontos.
create table premios (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  descricao text,
  ativo boolean not null default true,
  prazo_final date,                      -- "vale até esta data ou enquanto durar o estoque"
  estoque_total integer,                 -- null = ilimitado
  restrito boolean not null default false, -- true = só quem está em premio_elegiveis (ex: acesso ao BIME)
  ordem integer not null default 0,
  criado_em timestamptz not null default now()
);

-- O "cartão de pontuação" de cada prêmio: cada linha é um critério que soma
-- pontos PRA ESTE prêmio especificamente — a mesma trilha/regra pode valer
-- pontuações diferentes (ou nem contar) em outro prêmio.
--   tipo='regra'               -> conta pontos_regras(regra_id) satisfeita (produto ativo, ou evento aprovado)
--   tipo='trilha'               -> conta quando a trilha(trilha_id) específica está 100% concluída
--   tipo='trilhas_disponiveis'  -> conta quando TODAS as trilhas liberadas pro cliente estão 100% concluídas
--   tipo='atividade'            -> soma `pontos` a cada atividade de vídeo concluída (entre as trilhas liberadas)
create table premio_criterios (
  id uuid primary key default gen_random_uuid(),
  premio_id uuid not null references premios(id) on delete cascade,
  tipo text not null,
  regra_id uuid references pontos_regras(id) on delete cascade,
  trilha_id uuid references trilhas(id) on delete cascade,
  pontos integer not null,
  ordem integer not null default 0,
  criado_em timestamptz not null default now()
);
create index idx_premio_criterios_premio on premio_criterios (premio_id);

-- Um prêmio pode ter várias faixas de pontuação (ex: 100pts=grátis, 80=70% off, 60=50% off).
create table premio_faixas (
  id uuid primary key default gen_random_uuid(),
  premio_id uuid not null references premios(id) on delete cascade,
  pontos_minimos integer not null,
  descricao text not null,               -- "Grátis", "70% de desconto"
  ordem integer not null default 0
);
create index idx_premio_faixas_premio on premio_faixas (premio_id);

-- Lista de clientes elegíveis, só usada quando premios.restrito = true.
create table premio_elegiveis (
  premio_id uuid not null references premios(id) on delete cascade,
  cliente_id uuid not null references clientes(id) on delete cascade,
  primary key (premio_id, cliente_id)
);

-- Pedido de resgate — cliente confirma WhatsApp, equipe processa manualmente.
create table premio_resgates (
  id uuid primary key default gen_random_uuid(),
  premio_id uuid not null references premios(id) on delete cascade,
  faixa_id uuid references premio_faixas(id),
  cliente_id uuid not null references clientes(id) on delete cascade,
  email text not null,
  whatsapp text,
  status text not null default 'solicitado', -- 'solicitado' | 'contatado' | 'entregue' | 'cancelado'
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index idx_premio_resgates_premio on premio_resgates (premio_id);
create index idx_premio_resgates_status on premio_resgates (status);

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
alter table atividades_concluidas enable row level security;
alter table pontos_regras enable row level security;
alter table pontos_eventos enable row level security;
alter table premios enable row level security;
alter table premio_criterios enable row level security;
alter table premio_faixas enable row level security;
alter table premio_elegiveis enable row level security;
alter table premio_resgates enable row level security;
-- (fim das tabelas base — a migração no final do arquivo cria premio_criterios)

-- MIGRAÇÃO (rodar só se a tabela `trilhas` já existir com a coluna `produto`
-- antiga, de um texto só — troca por `produtos`, um array, sem perder trilha
-- nenhuma: cada uma migra pro array de 1 item com o produto que já tinha).
alter table trilhas add column if not exists produtos text[] not null default '{}';
update trilhas set produtos = array[produto] where produto is not null and produto <> '' and produtos = '{}';
alter table trilhas drop column if exists produto;
drop index if exists idx_trilhas_produto;

-- MIGRAÇÃO: nota por vídeo (texto livre, ex.: link pra base de conhecimento).
alter table trilha_videos add column if not exists nota text;

-- MIGRAÇÃO: gamificação (pontos, atividades por vídeo, prêmios e resgates).
alter table trilhas add column if not exists pontos_conclusao integer;
alter table trilha_videos add column if not exists atividade_titulo text;
alter table trilha_videos add column if not exists atividade_pontos integer;

create table if not exists atividades_concluidas (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references clientes(id) on delete cascade,
  email text not null,
  trilha_video_id uuid not null references trilha_videos(id) on delete cascade,
  concluida_em timestamptz not null default now(),
  unique (email, trilha_video_id)
);
create index if not exists idx_atividades_cliente on atividades_concluidas (cliente_id);

create table if not exists pontos_regras (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  pontos integer not null,
  tipo text not null,
  criterio_produtos text[] not null default '{}',
  pede_identificacao boolean not null default false,
  ativa boolean not null default true,
  ordem integer not null default 0,
  criado_em timestamptz not null default now()
);

create table if not exists pontos_eventos (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references clientes(id) on delete cascade,
  email text not null,
  regra_id uuid not null references pontos_regras(id) on delete cascade,
  status text not null default 'pendente',
  identificacao text,
  observacao text,
  criado_em timestamptz not null default now(),
  revisado_em timestamptz,
  revisado_por text,
  unique (email, regra_id)
);
create index if not exists idx_pontos_eventos_status on pontos_eventos (status);
create index if not exists idx_pontos_eventos_cliente on pontos_eventos (cliente_id);

create table if not exists premios (
  id uuid primary key default gen_random_uuid(),
  titulo text not null,
  descricao text,
  ativo boolean not null default true,
  prazo_final date,
  estoque_total integer,
  restrito boolean not null default false,
  ordem integer not null default 0,
  criado_em timestamptz not null default now()
);

create table if not exists premio_faixas (
  id uuid primary key default gen_random_uuid(),
  premio_id uuid not null references premios(id) on delete cascade,
  pontos_minimos integer not null,
  descricao text not null,
  ordem integer not null default 0
);
create index if not exists idx_premio_faixas_premio on premio_faixas (premio_id);

create table if not exists premio_elegiveis (
  premio_id uuid not null references premios(id) on delete cascade,
  cliente_id uuid not null references clientes(id) on delete cascade,
  primary key (premio_id, cliente_id)
);

create table if not exists premio_resgates (
  id uuid primary key default gen_random_uuid(),
  premio_id uuid not null references premios(id) on delete cascade,
  faixa_id uuid references premio_faixas(id),
  cliente_id uuid not null references clientes(id) on delete cascade,
  email text not null,
  whatsapp text,
  status text not null default 'solicitado',
  criado_em timestamptz not null default now(),
  atualizado_em timestamptz not null default now()
);
create index if not exists idx_premio_resgates_premio on premio_resgates (premio_id);
create index if not exists idx_premio_resgates_status on premio_resgates (status);

alter table atividades_concluidas enable row level security;
alter table pontos_regras enable row level security;
alter table pontos_eventos enable row level security;
alter table premios enable row level security;
alter table premio_faixas enable row level security;
alter table premio_elegiveis enable row level security;
alter table premio_resgates enable row level security;

-- MIGRAÇÃO: pontuação passa a ser POR PRÊMIO, não mais um total global.
-- A mesma regra/trilha/atividade pode valer pontuações diferentes em
-- prêmios diferentes — quem carrega o peso agora é premio_criterios, não
-- mais colunas soltas em trilhas/trilha_videos/pontos_regras.
alter table pontos_regras drop column if exists pontos;
alter table trilhas drop column if exists pontos_conclusao;
alter table trilha_videos drop column if exists atividade_pontos;

create table if not exists premio_criterios (
  id uuid primary key default gen_random_uuid(),
  premio_id uuid not null references premios(id) on delete cascade,
  tipo text not null,
  regra_id uuid references pontos_regras(id) on delete cascade,
  trilha_id uuid references trilhas(id) on delete cascade,
  pontos integer not null,
  ordem integer not null default 0,
  criado_em timestamptz not null default now()
);
create index if not exists idx_premio_criterios_premio on premio_criterios (premio_id);
alter table premio_criterios enable row level security;

-- MIGRAÇÃO: subtítulos de seção dentro de uma trilha (ex: trilha "Unique" com
-- seções "Folha de pagamento", "Contábil", "Fiscal"). Puramente de exibição —
-- vídeos com o mesmo subtitulo, adjacentes na ordem, aparecem agrupados sob
-- um cabeçalho de seção.
alter table trilha_videos add column if not exists subtitulo text;

-- MIGRAÇÃO: formulário de declaração configurável por regra. Antes só existia
-- um boolean pede_identificacao (um único input livre); agora cada regra
-- carrega a lista de campos que quer coletar (do catálogo fixo em
-- api/_lib/campos-formulario.js), e cada evento guarda as respostas dadas.
-- pede_identificacao/identificacao/observacao ficam OBSOLETOS aqui, mas só
-- serão removidos numa migração futura, depois de confirmar que o fluxo novo
-- está ok em produção (mesmo cuidado tomado na migração de trilhas.produto).
alter table pontos_regras add column if not exists campos_formulario jsonb not null default '[]';
-- formato: [{ "chave": "email", "obrigatorio": true }, ...] — chave sempre
-- uma das chaves de CATALOGO_CAMPOS.

alter table pontos_eventos add column if not exists respostas jsonb not null default '{}';
-- formato: { "email": "...", "whatsapp": "...", ... } — chaves = campos_formulario da regra.
update pontos_eventos set respostas = jsonb_build_object('identificacao', identificacao)
  where identificacao is not null and respostas = '{}';

-- MIGRAÇÃO: verificação automática contra campos já sincronizados do ClickUp
-- (Camp 2025 / Evento: Camp 2026), pra aprovar na hora quando o cliente se
-- autodeclara e o ClickUp já confirma — sem isso, cai na aprovação manual de
-- sempre. Ver VERIFICACAO_CLICKUP em api/_lib/clickup.js.
alter table clientes add column if not exists camp_2025_opcao_id text;
alter table clientes add column if not exists evento_camp_2026_opcao_id text;
alter table pontos_regras add column if not exists verificacao_clickup text;
-- null | 'camp_2025_participou' | 'evento_camp_2026_confirmado'
