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

" Bundles {
  set rtp+=~/.vim/bundle/vundle/
  call vundle#rc()
  Bundle 'gmarik/vundle'
  Bundle 'rking/ag.vim'
  Bundle 'digitaltoad/vim-pug'
  Bundle 'tpope/vim-fugitive'
  Bundle 'tpope/vim-surround'
  Bundle 'Raimondi/delimitMate'
  Bundle 'ctrlpvim/ctrlp.vim'
  Bundle 'ervandew/supertab'
  Bundle 'ddollar/nerdcommenter'
  Bundle 'tpope/vim-endwise'
  Bundle 'scrooloose/syntastic'
  Bundle 'scrooloose/nerdtree'
  Bundle 'godlygeek/tabular'
  Bundle 'majutsushi/tagbar'
  Bundle 'marijnh/tern_for_vim'
  Bundle 'powerline/powerline', {'rtp': 'powerline/bindings/vim/'}
  Bundle 'jistr/vim-nerdtree-tabs'
  Bundle 'terryma/vim-multiple-cursors'
  Bundle 'jwhitley/vim-matchit'
  Bundle 'moll/vim-node'
  Bundle 'joonty/vdebug.git'
  Bundle 'mattn/emmet-vim'
  Bundle 'editorconfig/editorconfig-vim'
  Bundle 'maxbrunsfeld/vim-yankstack'
  Bundle 'christoomey/vim-tmux-navigator'
  Bundle 'elmcast/elm-vim'
  Bundle 'metakirby5/codi.vim'
  Bundle 'mitermayer/vim-prettier'
  Bundle 'sheerun/vim-polyglot'
"}

" General {
  filetype plugin indent on " automatically detect files types
  syntax on                " syntax highlighting
  set mouse=a              " automatically enable mouse usage
  scriptencoding utf-8
  set history=1000          " store more history (default is 20)
  set nospell              " spell checking off
  set noswapfile            " don't use swapfiles

  " don't create backup files
  set nobackup
  set nowritebackup

  set clipboard^=unnamed

  " remove the delay when hitting esc in insert mode
  set noesckeys
  set ttimeout
  set ttimeoutlen=1

  set showbreak=↪

  set fillchars=diff:·

  " check for external file changes, and suppress notices from appearing in command line
  if has("autocmd")
    autocmd CursorHold,CursorMoved,BufEnter silent * checktime
  endif

  if has('mouse_sgr')
    set ttymouse=sgr
  endif
" }

" Vim UI {
  color monokai                                  " load a colourscheme
  set splitright                                  " open split panes to the right of the current pane
  set splitbelow                                  " open split panes underneath the current pane

  set cursorline                                  " highlight current line
  hi CursorLine term=bold cterm=bold ctermbg=233

  set colorcolumn=85                              " show column length hint for long lines

  set backspace=indent,eol,start                  " allow backspacing over everything in insert mode
  set linespace=0                                " No extra spaces between rows
  set relativenumber                              " relative line numbers on
  set showmatch                                  " show matching brackets/parenthesis
  set incsearch                                  " find as you type search
  set hlsearch                                    " highlight search terms
  set winminheight=0                              " windows can be 0 line high
  set ignorecase                                  " case insensitive search
  set smartcase                                  " case sensitive when uc present
  set wildmenu                                    " show list instead of just completing
  set wildmode=list:longest,full                  " command <Tab> completion, list matches, then longest common part, then all.
  set nowrap                                      " don't wrap lines
  set scrolljump=5                                " lines to scroll when cursor leaves screen
  set scrolloff=5                                " minimum lines to keep above and below cursor
  noh                                            " clear the initial highlight after sourcing
  set foldenable                                  " auto fold code
  set nospell                                    " disable spellcheck
  set shortmess=atI                              " prevent 'Press ENTER' prompt

  " highlight trailing white space
  highlight ExtraWhitespace ctermbg=red guibg=red
  match ExtraWhitespace /\s\+$/

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
  set autoindent                                                      " indent at the same level of the previous line
  set shiftwidth=2                                                    " use indents of 2 spaces
  set tabstop=2                                                      " indent every 2 columns
  set softtabstop=2                                                  " let backspace delete indent
  set expandtab
  autocmd BufNewFile,BufReadPost * set ai ts=2 sw=2 sts=2            " set above values when opening new files
" }

" Key Mappings {
  " set custom leader
  let mapleader = ','

  " navigate panes with <c-hhkl>
  nmap <silent> <c-k> :wincmd k<CR>
  nmap <silent> <c-j> :wincmd j<CR>
  nmap <silent> <c-h> :wincmd h<CR>
  nmap <silent> <c-l> :wincmd l<CR>

  " j and k navigate through wrapped lines
  nmap k gk
  nmap j gj

  " map common shift keys
  cmap Qall qall
  cmap Wa wall
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

  " clear trailing white space across file
  nnoremap <leader>T :%s/\s\+$//<cr>:let @/=''<CR>

  " quickly move to next and previous buffers
  map <leader>bn :bn<CR>
  map <leader>bp :bp<CR>

  " quick access to this .vimrc
  map <leader>vi :tabe ~/dotfiles/.vimrc<CR>
  map <leader>vs :source ~/.vimrc<CR>

  " set all windows to equal width
  map <leader>= <C-w>=

  " Ruby conveniences
  nmap <leader>bx :!bundle exec<space>
  nmap <leader>zx :!zeus<space>
  map <leader>bi :!bundle<CR>
  map <leader>bu :!bundle update<space>

  " restart pow
  map <leader>rp :!touch tmp/restart.txt<CR><CR>

" }

" Auto Commands {

  if has("autocmd")
    " Also load indent files, to automatically do language-dependent indenting.

    " Put these in an autocmd group, so that we can delete them easily.
    augroup vimrcEx
    au!

    " For all text files set 'textwidth' to 78 characters.
    autocmd BufRead *.txt,*.md,*.textile set textwidth=80

    " Never wrap slim files
    autocmd FileType slim setlocal textwidth=0

    " Delete trailing white space on save
    autocm BufWritePre * :%s/\s\+$//e

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

" Plugins {

  " Vundle {
    " Update / Install bundles
    map <leader>vbi :PluginInstall<CR>
    map <leader>vbu :PluginUpdate<CR>
  " }

  " ctrlP {
    let g:ctrlp_max_height = 25
    let g:ctrlp_show_hidden = 1
  " }

  " delimitMate {
    " expand a new line after a brace to autoindent
    let delimitMate_expand_cr = 1
    " if parentheses are opened with a space, add a matching space after the cursor
    let delimitMate_expand_space = 1
  " }

  " Fugitive {
    " git push
    nmap <leader>gp :exec ':Git push origin ' . fugitive#head()<CR>

    " git push to heroku
    nmap <leader>ghp :exec ':Git push heroku ' . fugitive#head()<CR>

    " git status
    map <silent> <leader>gs :Gstatus<CR>/not staged<CR>/modified<CR>

    " git commit -am "
    map <leader>gci :Git commit -am "

    " git checkout
    map <leader>gco :Git checkout<space>

    " git diff
    map <leader>gd :Gdiff<CR>

    " git gui
    map <leader>ggui :Git gui<CR>
    map <leader>gw :!git add . && git commit -m "WIP"

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
    let g:prettier#config#trailing_comma = 'es5'

    " let g:prettier#quickfix_enabled = 0
    let g:prettier#autoformat = 0
    autocmd BufWritePre *.js,*.json,*.css,*.scss PrettierAsync
  " }

  " Powerline {
    let g:Powerline_symbols = 'fancy'
  " }

  " Syntastic {
    set statusline+=%#warningmsg#
    set statusline+=%{SyntasticStatuslineFlag()}
    set statusline+=%*

    let g:syntastic_always_populate_loc_list = 1
    let g:syntastic_auto_loc_list = 1
    let g:syntastic_check_on_open = 1
    let g:syntastic_check_on_wq = 0
  " }

  " Vim JSX (via vim-polyglot) {
    let g:jsx_ext_required = 0
  " }

  " Tabularize {
    if exists(":Tabularize")
      " align equal signs in normal and visual mode
      nmap <Leader>a= :Tabularize /=<CR>
      vmap <Leader>a= :Tabularize /=<CR>

      " align colons in normal and visual mode
      nmap <Leader>a: :Tabularize /:\zs<CR>
      vmap <Leader>a: :Tabularize /:\zs<CR>
    endif
  " }

  " Typescript Vim {
    au BufRead,BufNewFile *.ts   setfiletype typescript
  " }

  " The Silver Searcher {
    " Source: https://github.com/thoughtbot/dotfiles/blob/master/vimrc
    if executable('ag')
      " Use Ag over Grep
      set grepprg=ag\ --nogroup\ --nocolor

      " Use ag in CtrlP for listing files. Lightning fast and respects .gitignore
      let g:ctrlp_user_command = 'ag %s -l --nocolor -g ""'
    endif
  " }

  " vdebug {
  let g:vdebug_options = {
  \  "port" : 9000,
  \  "server" : 'localhost',
  \  "timeout" : 20,
  \  "on_close" : 'detach',
  \  "break_on_open" : 0,
  \  "ide_key" : '',
  \  "path_maps" : {},
  \  "debug_window_level" : 0,
  \  "debug_file_level" : 0,
  \  "debug_file" : "",
  \  "watch_window_style" : 'expanded',
  \  "marker_default" : '⬦',
  \  "marker_closed_tree" : '▸',
  \  "marker_open_tree" : '▾'
  \}
  " }

  " Emmet {
  let g:user_emmet_settings = {
  \ 'indentation': '  ',
  \ 'php' : {
  \   'extends' : 'html',
  \   'filters' : 'html',
  \   'dollar_expr': 0,
  \ },
  \}
  " }

  " Editorconfig {
    let g:EditorConfig_core_mode = 'external_command'
  " }

  " Elm {
    let g:syntastic_always_populate_loc_list = 1
    let g:syntastic_auto_loc_list = 1

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
" }
