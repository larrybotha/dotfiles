" don't use ale for LSP
let g:ale_disable_lsp = 1
let g:ale_javascript_eslint_executable = 'eslint_d'
let g:ale_javascript_eslint_use_global = 1
let g:ale_javascript_prettier_executable = 'prettier_d_slim'
let g:ale_javascript_prettier_use_global = 1

let g:ale_fixers = {
  \ 'graphql': ['prettier'],
  \ 'html': ['prettier'],
  \ 'javascript': ['prettier', 'eslint'],
  \ 'javascriptreact': ['prettier', 'eslint'],
  \ 'json': ['prettier', 'fixjson'],
  \ 'markdown': ['prettier'],
  \ "python": [ 'isort', 'autoimport', 'ale#fixers#generic_python#BreakUpLongLines', 'black'],
  \ 'svelte': ['prettier'],
  \ 'typescript': ['prettier', 'eslint'],
  \ 'typescriptreact': ['prettier', 'eslint'],
  \ 'vue': ['prettier'],
  \ 'yaml': ['prettier'],
\}

let g:ale_fix_on_save = 1

