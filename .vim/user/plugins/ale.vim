" don't use ale for LSP
let g:ale_disable_lsp = 1
let g:ale_use_global_executables = 1
let g:ale_fix_on_save = 1

let g:ale_javascript_eslint_executable = 'eslint_d'
let g:ale_javascript_prettier_executable = 'prettier_d_slim'

let g:ale_fixers = {
  \ 'graphql': ['prettier'],
  \ 'html': ['prettier'],
  \ 'javascript': ['prettier', 'eslint'],
  \ 'javascriptreact': ['prettier', 'eslint'],
  \ 'json': ['prettier', 'fixjson'],
  \ 'markdown': ['prettier'],
  \ 'php': ['php_cs_fixer'],
  \ "python": [ 'isort', 'autoimport', 'ale#fixers#generic_python#BreakUpLongLines', 'black'],
  \ 'svelte': ['prettier'],
  \ 'typescript': ['prettier', 'eslint'],
  \ 'typescriptreact': ['prettier', 'eslint'],
  \ 'vue': ['prettier'],
  \ 'yaml': ['prettier'],
\}

let g:ale_linters_ignore = {'php': ['phpcs']}

" format .html.php files with prettier on save
let g:ale_pattern_options = {
  \ '\.html\.php$': {
    \ 'ale_fixers': ['prettier', 'php_cs_fixer'],
  \ },
\}
autocmd BufWritePost *.html.php let b:ale_javascript_prettier_options = '--parser=html'
