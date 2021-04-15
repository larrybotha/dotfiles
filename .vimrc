" Modeline and Notes {
" vim: set foldmarker={,} foldlevel=0 foldmethod=marker spell:
"  This .vimrc is largely inspired by
"  https://github.com/spf13/spf13-vim/blob/master/.vimrc and
"  https://github.com/kmckelvin/vimrc/blob/master/vimrc
" }

" Environment {
  " Basics {
    set nocompatible " must come first
    set background=dark " assume a dark background
  "}
"}

" Plugin Installation {
  " install Plug if it isn't already
  if empty(glob('~/.vim/autoload/plug.vim'))
    silent !curl -fLo ~/.vim/autoload/plug.vim --create-dirs
      \ https://raw.githubusercontent.com/junegunn/vim-plug/master/plug.vim
    autocmd VimEnter * PlugInstall --sync | source $MYVIMRC
  endif

  " conditionally get options
  function! Cond(cond, ...)
    let opts = get(a:000, 0, {})
    return a:cond ? opts : extend(opts, { 'on': [], 'for': [] })
  endfunction

  call plug#begin('~/.vim/plugged')
  Plug 'ervandew/supertab'
  Plug 'tpope/vim-sensible'
  Plug 'rking/ag.vim'
  Plug 'tpope/vim-fugitive'
  Plug 'tpope/vim-surround'
  Plug 'preservim/nerdcommenter'
  Plug 'tpope/vim-endwise'
  Plug 'scrooloose/syntastic'
  Plug 'scrooloose/nerdtree'
  Plug 'brett-griffin/phpdocblocks.vim'
  Plug 'godlygeek/tabular'
  Plug 'vim-airline/vim-airline'
  Plug 'edkolev/tmuxline.vim'
  Plug 'jistr/vim-nerdtree-tabs'
  Plug 'terryma/vim-multiple-cursors'
  Plug 'moll/vim-node'
  Plug 'vim-vdebug/vdebug'
  Plug 'mattn/emmet-vim'
  Plug 'editorconfig/editorconfig-vim'
  Plug 'maxbrunsfeld/vim-yankstack'
  Plug 'christoomey/vim-tmux-navigator'
  Plug 'elmcast/elm-vim'
  Plug 'metakirby5/codi.vim'
  "Plug 'prettier/vim-prettier'
  Plug 'sheerun/vim-polyglot'
  Plug 'leafgarland/typescript-vim'
  Plug 'Quramy/tsuquyomi'
  Plug 'heavenshell/vim-jsdoc'
  Plug 'janko-m/vim-test'
  Plug 'tmux-plugins/vim-tmux-focus-events'
  Plug 'airblade/vim-gitgutter'
  Plug 'fatih/vim-go', {'do': ':GoInstallBinaries'}
  Plug 'junegunn/fzf', { 'dir': '~/.fzf', 'do': './install --all' }
  Plug 'junegunn/fzf.vim'
  Plug 'ludovicchabant/vim-gutentags'
  Plug 'neoclide/coc.nvim', {'do': { -> coc#util#install()}}
  Plug 'rhysd/git-messenger.vim'
  Plug 'evanleck/vim-svelte', {'branch': 'main'}
  Plug 'Raimondi/delimitMate'
  Plug 'rust-lang/rust.vim'
  " only load if we are in Neovim
  Plug 'jodosha/vim-godebug', Cond(has('nvim'))
  call plug#end()
"}

" General {
  filetype plugin indent on " automatically detect files types
  syntax on                 " syntax highlighting
  set mouse=a               " automatically enable mouse usage
  scriptencoding utf-8
  set history=1000          " store more history (default is 20)
  set nospell               " spell checking off
  set noswapfile            " don't use swapfiles

  " don't create backup files
  set nobackup
  set nowritebackup

  if !has('nvim')
    " remove the delay when hitting esc in insert mode
    set noesckeys
  endif

  set ttimeout
  set ttimeoutlen=1

  set showbreak=↪

  set fillchars=diff:·

  " check for external file changes, and suppress notices from appearing in command line
  " requires tmux-focus-events plugin for tmux support
  au FocusGained,BufEnter * :checktime " when buffer is changed
  " when cursor stops moving
  " https://vi.stackexchange.com/questions/14315/how-can-i-tell-if-im-in-the-command-window
  autocmd FocusGained,BufEnter,CursorHold,CursorHoldI *
                \ if mode() == 'n' && getcmdwintype() == '' | checktime | endif
  set autoread


  if has('mouse_sgr')
    set ttymouse=sgr
  endif
" }

" Vim UI {
  color monokai                                  " load a colourscheme
  set splitright                                 " open split panes to the right of the current pane
  set splitbelow                                 " open split panes underneath the current pane

  set cursorline                                 " highlight current line
  hi CursorLine term=bold cterm=bold ctermbg=233

  set colorcolumn=85                             " show column length hint for long lines

  set backspace=indent,eol,start                 " allow backspacing over everything in insert mode
  set linespace=0                                " No extra spaces between rows
  set relativenumber                             " relative line numbers on
  set showmatch                                  " show matching brackets/parenthesis
  set incsearch                                  " find as you type search
  set hlsearch                                   " highlight search terms
  set winminheight=0                             " windows can be 0 line high
  set ignorecase                                 " case insensitive search
  set smartcase                                  " case sensitive when uc present
  set wildmenu                                   " show list instead of just completing
  set wildmode=list:longest,full                 " command <Tab> completion, list matches, then longest common part, then all.
  set nowrap                                     " don't wrap lines
  set scrolljump=5                               " lines to scroll when cursor leaves screen
  set scrolloff=5                                " minimum lines to keep above and below cursor
  noh                                            " clear the initial highlight after sourcing
  set foldenable                                 " auto fold code
  set nospell                                    " disable spellcheck
  set shortmess=atI                              " prevent 'Press ENTER' prompt

  " highlight trailing white space
  hi ExtraWhitespace ctermbg=197 guibg=red
  match ExtraWhitespace /\s\+$/

  " make error messages more legible
  hi Error        ctermfg=0   ctermbg=1   guifg=black   guibg=red
  hi ErrorMsg     ctermfg=0   ctermbg=1   guifg=black   guibg=red
  hi SpellBad     ctermfg=0   ctermbg=1   guifg=black   guibg=red
  hi WarningMsg   ctermfg=0   ctermbg=1   guifg=black   guibg=red

  " make debugger lines more legible
  hi RedrawDebugComposed ctermbg=2 guibg=green
  hi RedrawDebugRecompose ctermbg=1 guibg=red


  " switch relative line numbers to absolute when Vim is not in focus
  :au FocusLost * :set number
  :au FocusGained * :set relativenumber

  " use absolute numbers when in Insert mode
  autocmd InsertEnter * :set number
  autocmd InsertLeave * :set relativenumber

  " show timeout on leader
  set showcmd

  " moving panes
  map <leader>mh :wincmd H<CR>
  map <leader>mj :wincmd J<CR>
  map <leader>mk :wincmd K<CR>
  map <leader>ml :wincmd L<CR>

  " change cursor to caret when in insert mode in tmux
  if exists('$TMUX')
    let &t_SI = "\<Esc>Ptmux;\<Esc>\<Esc>]50;CursorShape=1\x7\<Esc>\\"
    let &t_EI = "\<Esc>Ptmux;\<Esc>\<Esc>]50;CursorShape=0\x7\<Esc>\\"
  else
    let &t_SI = "\<Esc>]50;CursorShape=1\x7"
    let &t_EI = "\<Esc>]50;CursorShape=0\x7"
  endif
" }

" Formatting {
  set autoindent                                          " indent at the same level of the previous line
  set shiftwidth=2                                        " use indents of 2 spaces
  set tabstop=2                                           " indent every 2 columns
  set softtabstop=2                                       " let backspace delete indent
  set expandtab
  autocmd BufNewFile,BufReadPost * set ai ts=2 sw=2 sts=2 " set above values when opening new files
" }

" Key Mappings {
  " set custom leader
  let mapleader = ','

  " j and k navigate through wrapped lines
  nmap k gk
  nmap j gj

  " map common shift keys
  cmap Qall qall
  cmap W w
  cmap Tabe tabe

  " yank from cursor to EOL the same as C and D do
  nnoremap Y y$

  " code folding options
  nmap <leader>f0 :set foldlevel=0<CR>
  nmap <leader>f1 :set foldlevel=1<CR>
  nmap <leader>f2 :set foldlevel=2<CR>
  nmap <leader>f3 :set foldlevel=3<CR>
  nmap <leader>f4 :set foldlevel=4<CR>
  nmap <leader>f5 :set foldlevel=5<CR>
  nmap <leader>f6 :set foldlevel=6<CR>
  nmap <leader>f7 :set foldlevel=7<CR>
  nmap <leader>f8 :set foldlevel=8<CR>
  nmap <leader>f9 :set foldlevel=9<CR>

  " clear highlighted searches
  nmap <silent> <leader>/ :nohlsearch<CR>

  " visual shifting without exiting visual mode
  vnoremap < <gv
  vnoremap > >gv

  " quickly move lines up and down with <A-J> == ∆ and <A-K> == ˚
  nnoremap ∆ :m .+1<CR>==
  nnoremap ˚ :m .-2<CR>==
  inoremap ∆ <Esc>:m .+1<CR>==gi
  inoremap ˚ <Esc>:m .-2<CR>==gi
  vnoremap ∆ :m '>+1<CR>gv=gv
  vnoremap ˚ :m '<-2<CR>gv=gv

  " Emacs-like beginning and end of line
  imap <c-e> <c-o>$
  imap <c-a> <c-o>^

  " paste, fix indentation and clear the mark by default
  nnoremap p p=`]`<esc>

  " quickly move to next and previous buffers
  map <leader>bn :bn<CR>
  map <leader>bp :bp<CR>

  " quick access to this .vimrc
  map <leader>vi :tabe ~/dotfiles/.vimrc<CR>
  map <leader>vs :source $MYVIMRC<CR>

  " set all windows to equal width
  map <leader>= <C-w>=
" }

" Auto Commands {

  if has("autocmd")
    " Also load indent files, to automatically do language-dependent indenting.

    " Put these in an autocmd group, so that we can delete them easily.
    augroup vimrcEx
    au!

    " For all text files set 'textwidth' to 78 characters.
    autocmd BufRead *.txt,*.md,*.svx,*.textile set textwidth=80

    " Set .svx files as markdown
    autocmd BufRead *.svx set ft=markdown

    " Delete trailing white space on save
    autocmd BufWritePre * :%s/\s\+$//e

    " When editing a file, always jump to the last known cursor position.
    " Don't do it when the position is invalid or when inside an event handler
    " (happens when dropping a file on gvim).
    autocmd BufReadPost *
      \ if line("'\"") > 0 && line("'\"") <= line("$") |
      \  exe "normal g`\"" |
      \ endif

    augroup END

  endif " has("autocmd")

" }

" Plugin Configs {

  " Plug {
    " Update / Install bundles
    map <leader>vbi :PlugInstall<CR>
    map <leader>vbu :PlugUpdate<CR>
  " }

  " coc.vim {
    " install extensions
    let g:coc_global_extensions  = [
      \ 'coc-css',
      \ 'coc-rust-analyzer',
      \ 'coc-svg',
      \ 'coc-emmet',
      \ 'coc-html',
      \ 'coc-java',
      \ 'coc-json',
      \ 'coc-phpls',
      \ 'coc-python',
      \ 'coc-svelte',
      \ 'coc-tslint-plugin',
      \ 'coc-tsserver',
      \ 'coc-yaml',
    \]

    " if hidden is not set, TextEdit might fail.
    set hidden

    " Some servers have issues with backup files, see #649
    set nobackup
    set nowritebackup

    " Better display for messages
    set cmdheight=2

    " Smaller updatetime for CursorHold & CursorHoldI
    set updatetime=300

    " don't give |ins-completion-menu| messages.
    set shortmess+=c

    " always show signcolumns
    set signcolumn=yes

    " Use tab for trigger completion with characters ahead and navigate.
    " Use command ':verbose imap <tab>' to make sure tab is not mapped by other plugin.
    inoremap <silent><expr> <TAB>
          \ pumvisible() ? "\<C-n>" :
          \ <SID>check_back_space() ? "\<TAB>" :
          \ coc#refresh()
    " GAAAAAAAAAAAAAAAARRRHHH WTF IS WRONG WITH THIS GODDAMN CONFIG
    " inoremap <expr> <S-TAB> pumvisible() ? "\<C-p>" : "\<S-TAB>"

    function! s:check_back_space() abort
      let col = col('.') - 1
      return !col || getline('.')[col - 1]  =~# '\s'
    endfunction

    " Use <c-space> to trigger completion.
    inoremap <silent><expr> <c-space> coc#refresh()

    " Use <cr> to confirm completion, `<C-g>u` means break undo chain at current position.
    " Coc only does snippet and additional edit on confirm.
    " inoremap <expr> <cr> pumvisible() ? "\<C-y>" : "\<C-g>u\<CR>"

    " Use `[c` and `]c` to navigate diagnostics
    nmap <silent> [c <Plug>(coc-diagnostic-prev)
    nmap <silent> ]c <Plug>(coc-diagnostic-next)

    " Remap keys for gotos
    nmap <silent> gd <Plug>(coc-definition)
    nmap <silent> gy <Plug>(coc-type-definition)
    nmap <silent> gi <Plug>(coc-implementation)
    nmap <silent> gr <Plug>(coc-references)

    " Use K to show documentation in preview window
    nnoremap <silent> K :call <SID>show_documentation()<CR>

    function! s:show_documentation()
      if (index(['vim','help'], &filetype) >= 0)
        execute 'h '.expand('<cword>')
      else
        call CocAction('doHover')
      endif
    endfunction

    " Highlight symbol under cursor on CursorHold
    autocmd CursorHold * silent call CocActionAsync('highlight')

    " Remap for rename current word
    nmap <leader>rn <Plug>(coc-rename)

    " Remap for format selected region
    xmap <leader>f  <Plug>(coc-format-selected)
    nmap <leader>f  <Plug>(coc-format-selected)

    augroup mygroup
      autocmd!
      " Setup formatexpr specified filetype(s).
      autocmd FileType typescript,json setl formatexpr=CocAction('formatSelected')
      " Update signature help on jump placeholder
      autocmd User CocJumpPlaceholder call CocActionAsync('showSignatureHelp')
    augroup end

    " Remap for do codeAction of selected region, ex: `<leader>aap` for current paragraph
    xmap <leader>a  <Plug>(coc-codeaction-selected)
    nmap <leader>a  <Plug>(coc-codeaction-selected)

    " Remap for do codeAction of current line
    nmap <leader>ac  <Plug>(coc-codeaction)
    " Fix autofix problem of current line
    nmap <leader>qf  <Plug>(coc-fix-current)

    " Use `:Format` to format current buffer
    command! -nargs=0 Format :call CocAction('format')

    " Use `:Fold` to fold current buffer
    command! -nargs=? Fold :call     CocAction('fold', <f-args>)

    " Using CocList
    " Show all diagnostics
    nnoremap <silent> <space>a  :<C-u>CocList diagnostics<cr>
    " Manage extensions
    nnoremap <silent> <space>e  :<C-u>CocList extensions<cr>
    " Show commands
    nnoremap <silent> <space>c  :<C-u>CocList commands<cr>
    " Find symbol of current document
    nnoremap <silent> <space>o  :<C-u>CocList outline<cr>
    " Search workspace symbols
    nnoremap <silent> <space>s  :<C-u>CocList -I symbols<cr>
    " Do default action for next item.
    nnoremap <silent> <space>j  :<C-u>CocNext<CR>
    " Do default action for previous item.
    nnoremap <silent> <space>k  :<C-u>CocPrev<CR>
    " Resume latest coc list
    nnoremap <silent> <space>p  :<C-u>CocListResume<CR>

  " }

  " delimitMate {
    " expand a new line after a brace to autoindent
    let delimitMate_expand_cr = 1
    " if parentheses are opened with a space, add a matching space after the cursor
    let delimitMate_expand_space = 1
  " }

  " rust-lang/rust {
    let g:autofmt_autosave = 1

  " }

 " vim-go {
    " format and rewrite imports on save
    let g:go_fmt_command = 'goimports'
    " show type info under cursor
    let g:go_auto_type_info = 1
  " }

  " Fugitive {
    " git push
    nmap <leader>gp :exec ':Git push origin ' . fugitive#head()<CR>

    " git status
    map <silent> <leader>gs :Gstatus<CR>

    " git commit -am "
    map <leader>gci :Git commit -am "

    " git checkout
    map <leader>gco :Git checkout<space>

    " git diff
    map <leader>gd :Gdiff<CR>
  " }

  " fzf {
    nnoremap <C-p> :Files<CR>
    nnoremap <Leader>b :Buffers<CR>
    nnoremap <Leader>h :History<CR>

    nnoremap <Leader>T :Tags<CR>

    " --column: Show column number
    " --line-number: Show line number
    " --no-heading: Do not show file headings in results
    " --fixed-strings: Search term as a literal string
    " --ignore-case: Case insensitive search
    " --no-ignore: Do not respect .gitignore, etc...
    " --hidden: Search hidden files and folders
    " --follow: Follow symlinks
    " --glob: Additional conditions for search (in this case ignore everything in the .git/ folder)
    " --color: Search color options
    let g:rg_command = 'rg --column --line-number --no-heading --fixed-strings
      \ --ignore-case --hidden --follow --color "always"
      \ -g "!{.git,node_modules,vendor,build,dist}/*" '

    " use :F to search everything with ripgrep
    command! -bang -nargs=* F call fzf#vim#grep(g:rg_command .shellescape(<q-args>).'| tr -d "\017"', 1, <bang>0)
  " }


  " JsDoc {
  " }

  " NERDTree {
    " quick access to NERDTree
    map <leader>n :NERDTreeTabsToggle<CR>
    map <leader>ff :NERDTreeFind<CR>

    " open NERDTree on startup
    let g:nerdtree_tabs_open_on_console_startup = 1

    " show hidden files by default
    let NERDTreeShowHidden=1
  " }

  " PHPFmt {
    let g:phpfmt_standard = 'PSR2'
  " }


  " Prettier {
    if exists(":Prettier")
      let g:prettier#config#trailing_comma = 'es5'

      " let g:prettier#quickfix_enabled = 0
      let g:prettier#autoformat = 0
      autocmd BufWritePre *.js,*.json,*.ts,*.tsx,*.vue,*.graphql PrettierAsync
    endif
  " }

  " Airline {
    let g:airline_powerline_fonts = 1
    let g:airline#extensions#tabline#enabled = 1
    let g:airline#extensions#tabline#buffer_nr_show = 1
  " }

  " Syntastic {
    let g:syntastic_always_populate_loc_list = 1
    let g:syntastic_auto_loc_list = 0
    let g:syntastic_check_on_open = 1
    let g:syntastic_check_on_wq = 0
    " requires yamllint to be installed with pip
    let g:syntastic_yaml_checkers = ['yamllint']
    " install jsonlint via npm for json linting
  " }

  " Vim JSX (via vim-polyglot) {
    let g:jsx_ext_required = 0
  " }

  " Tabular {
    if exists(":Tabularize")
      " align equal signs in normal and visual mode
      nmap <Leader>a= :Tabularize /=<CR>
      vmap <Leader>a= :Tabularize /=<CR>

      " align colons in normal and visual mode
      nmap <Leader>a: :Tabularize /:\zs<CR>
      vmap <Leader>a: :Tabularize /:\zs<CR>
    endif

    " use Tabularize when in insert mode and a | is typed
    " http://vimcasts.org/episodes/aligning-text-with-tabular-vim/
    inoremap <silent> <Bar>   <Bar><Esc>:call <SID>align()<CR>a

    function! s:align()
      let p = '^\s*|\s.*\s|\s*$'
      if exists(':Tabularize') && getline('.') =~# '^\s*|' && (getline(line('.')-1) =~# p || getline(line('.')+1) =~# p)
        let column = strlen(substitute(getline('.')[0:col('.')],'[^|]','','g'))
        let position = strlen(matchstr(getline('.')[0:col('.')],'.*|\s*\zs.*'))
        Tabularize/|/l1
        normal! 0
        call search(repeat('[^|]*|',column).'\s\{-\}'.repeat('.',position),'ce',line('.'))
      endif
    endfunction
  " }

  " Typescript Vim {
    " We force typescript as a file everywhere because Vim added typescriptreact
    " filetype, breaking detection for a whole bunch of plugins
    " https://github.com/vim/vim/issues/4830
    autocmd BufNewFile,BufRead *.tsx set filetype=typescript.tsx
  " }

  " Tsuquyomi {
    let g:tsuquyomi_disable_quickfix = 1
    let g:syntastic_typescript_checkers = ['tsuquyomi']
    " makes completion slow
    let g:tsuquyomi_completion_detail = 1
    autocmd FileType typescript      setlocal completeopt+=menu,preview
    autocmd FileType typescript      nmap <buffer> <Leader>ts : <C-u>echo tsuquyomi#hint()<CR>
  " }

  " vdebug {
  if !exists('g:vdebug_options')
    let g:vdebug_options = {}
  endif

  let g:vdebug_options["break_on_open"] = 0
  let g:vdebug_options["path_maps"] = {
  \ "/var/www/html": "/Users/larry/Sites/sa-trust/knowledge-hub/src"
  \}

  " Emmet {
  let g:user_emmet_settings = {
  \ 'indentation': '  ',
  \ 'php' : {
  \   'extends' : 'html',
  \   'filters' : 'html',
  \   'dollar_expr': 0,
  \ },
  \ 'typescript' : {
  \     'extends' : 'jsx',
  \ },
  \ 'javascript.jsx' : {
  \     'extends' : 'jsx',
  \ },
  \}
  " }

  " Editorconfig {
    let g:EditorConfig_exclude_patterns = ['fugitive://.\*']
  " }

  " Elm {
    let g:elm_syntastic_show_warnings = 1
    let g:elm_format_autosave = 1
  " }

  " YankStack {
    " don't use default key mappings
    let g:yankstack_map_keys = 0

    " alt-p
    nmap π <Plug>yankstack_substitute_older_paste
    " alt-P
    nmap ∏ <Plug>yankstack_substitute_newer_paste
  " }

  " Vim Test {
    let test#strategy = "vimterminal"
    let g:test#preserve_screen = 1
    " run Jest tests in debug mode at port 9222, running in band, so that
    " debugger breakpoints are respected
    let test#javascript#jest#executable = 'node --inspect=9222 $(npm bin)/jest --runInBand --no-cache'
    let g:test#javascript#jest#file_pattern = '\v(__tests__/.*|(spec|test))(.*)?\.(js|jsx|ts|tsx)$'

    nmap <silent> t<C-n> :TestNearest<CR> " t Ctrl+n
    nmap <silent> t<C-f> :TestFile<CR>    " t Ctrl+f
    nmap <silent> t<C-s> :TestSuite<CR>   " t Ctrl+s
    nmap <silent> t<C-l> :TestLast<CR>    " t Ctrl+l
    nmap <silent> t<C-g> :TestVisit<CR>   " t Ctrl+g
  " }
" }
