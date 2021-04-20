" don't use ale for LSP
let g:ale_disable_lsp = 1

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

