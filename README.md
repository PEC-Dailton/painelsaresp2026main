# Painel SARESP 2026

## Sincronização com a planilha Google

O painel lê o CSV publicado da planilha Google diretamente pelo navegador, sem banco de dados ou servidor adicional. A página atualiza os dados automaticamente a cada minuto; o botão **Sincronizar planilha Google** força uma nova leitura.

Os CSVs são configurados em `config.js`. O painel lê as abas por escola e por turma de 6º, 7º, 8º, 9º anos e 1ª, 2ª e 3ª séries. No filtro **Visualização**, “Por escola” usa os dados consolidados por unidade e “Por turma” usa as abas específicas com série, turma e período. Ao selecionar uma série, o filtro de data mostra os dias previstos para ela e quaisquer outras datas com dados sincronizados. Uma data sem resultados aparece sem registros, não como totais zerados.

As datas previstas de aplicação em 2026 são: 1ª série (12 e 13/11), 2ª série (10 e 11/11), 3ª série (04 e 05/11), 2ª Itinerário (09/11), 3ª Itinerário (06/11), 6º ano (18 e 19/11), 7º ano (26 e 27/11), 8º ano (30/11 e 01/12) e 9º ano (28 e 29/10).

O gráfico de colunas **Participação por ano / série** compara todas as séries usando a média dos percentuais de participação em cada dia de aplicação disponível para cada série. Ele não é limitado pelo dia escolhido no filtro; séries sem dados lançados não exibem coluna.

Na tabela e no gráfico, **% Participação** usa verde para participação ≥ 80% e vermelho para participação < 80%. **% Ausentes** usa farol invertido: verde para ausência < 1%, amarelo para ausência ≥ 1% e ≤ 20% e vermelho para ausência > 20%.

No **Detalhamento da aplicação**, o botão **Baixar planilha (.CSV)** exporta todos os registros consolidados que correspondem aos filtros atuais, inclusive quando a tabela exibe apenas parte dos resultados. O arquivo usa separador e formatação numérica compatíveis com o Excel em português.

As sete abas são definidas em `PAINEL_SHEET_CSV_URLS` no arquivo `config.js`. Para usar outra aba, acrescente uma entrada com seu endereço CSV e o rótulo da série correspondente. Como a publicação CSV é pública, não aponte para planilhas com informações individuais ou confidenciais.

## Publicar a interface no GitHub Pages

O workflow em `.github/workflows/pages.yml` publica automaticamente apenas os arquivos da interface. `server.py`, `config.py`, testes e outros arquivos do repositório não são enviados ao site.

1. Envie o projeto para um repositório GitHub.
2. Em **Settings → Pages**, selecione **GitHub Actions** como origem de publicação.
3. Faça push para `main` ou `master` (ou execute manualmente o workflow em **Actions**).
4. A URL do painel aparecerá no resultado do workflow.

O workflow publica a interface e o arquivo `config.js` com as sete abas. Para alterar a fonte ou incluir novas abas, atualize `PAINEL_SHEET_CSV_URLS` em `config.js` e publique novamente.

## Conexão opcional com o SharePoint

O fluxo CSV atende à planilha agregada publicada acima. GitHub Pages não executa `server.py` nem pode usar a sessão institucional do Windows. Se for necessário consultar o SharePoint ou dados privados, a equipe de TI precisa disponibilizar uma API HTTPS institucional que:

- autentique e autorize os usuários da instituição;
- ofereça os endpoints usados pelo painel (`/api/status`, `/api/data`, `/api/dashboard`, `/auth/login` e `/auth/logout`);
- permita chamadas do domínio do GitHub Pages via CORS;
- mantenha os dados e credenciais protegidos, sem incorporá-los aos arquivos públicos do site.

Depois que a API segura estiver implantada, cadastre sua URL base como variável de repositório `PAINEL_API_URL` em **Settings → Secrets and variables → Actions → Variables**. O workflow a injeta no site durante a publicação. Essa URL não deve conter credenciais ou tokens.

**Não exponha o `server.py` atual diretamente à internet.** Ele foi projetado para uso local e não possui autenticação de usuários adequada para proteger os dados.

## Uso local

O servidor local com SharePoint continua disponível: execute `INICIAR_PAINEL.bat` ou `python server.py` em um Windows com acesso institucional e abra `http://127.0.0.1:8000/`.
