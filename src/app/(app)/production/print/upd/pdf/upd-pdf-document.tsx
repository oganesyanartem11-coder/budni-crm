import path from 'node:path'
import { Document, Page, View, Text, StyleSheet, Font } from '@react-pdf/renderer'
import { formatDateNumeric, formatMoney } from '@/lib/utils/format'
import { amountToWords } from '@/lib/upd/amount-to-words'
import type {
  UpdSupplierSnapshot,
  UpdBuyerSnapshot,
  UpdLineSnapshot,
} from '../types'

// PT Sans (OFL) — кириллица. public/ копируется в bundle Vercel-функции,
// process.cwd() = корень функции на runtime'е. Italic-начертание НЕ
// зарегистрировано — fontStyle:'italic' использовать нельзя (рендер падает 500).
const FONT_DIR = path.join(process.cwd(), 'public', 'fonts', 'pt-sans')
Font.register({
  family: 'PT Sans',
  fonts: [
    { src: path.join(FONT_DIR, 'PTSans-Regular.ttf') },
    { src: path.join(FONT_DIR, 'PTSans-Bold.ttf'), fontWeight: 'bold' },
  ],
})
// Юр-документ: переносы по слогам недопустимы.
Font.registerHyphenationCallback((word) => [word])

export interface UpdPdfDocData {
  documentNumber: string
  deliveryDate: Date
  totalAmount: string
  vatAmount: string | null
  vatRate: string | null
  amountWithoutVat: string
  supplier: UpdSupplierSnapshot
  buyer: UpdBuyerSnapshot
  lines: UpdLineSnapshot[]
}

const COPY_LABEL_SELLER = 'Экземпляр 1 (для продавца)'
const COPY_LABEL_BUYER = 'Экземпляр 2 (для покупателя)'

const POSTANOVLENIE =
  'Приложение № 1 к постановлению Правительства Российской Федерации от 26 декабря 2011 г. № 1137 (в редакции постановления Правительства Российской Федерации от 23 января 2026 г. № 26)'

const MONTH_GENITIVE = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
] as const

// Ширины колонок таблицы в процентах. Сумма = 100.
const COL = {
  codeTRU: '4%',
  no: '3%',
  name: '22%',
  codeKind: '4%',
  unitGroup: '7%',
  qty: '5%',
  price: '6%',
  totalWithoutVat: '7%',
  excise: '5%',
  rate: '5%',
  vat: '7%',
  totalWithVat: '7%',
  countryGroup: '10%',
  customs: '8%',
} as const

const C_BORDER = '#999'
const C_LIGHT = '#777'

const styles = StyleSheet.create({
  page: {
    fontFamily: 'PT Sans',
    fontSize: 7.5,
    color: '#000',
    paddingTop: 16,
    paddingBottom: 24,
    paddingHorizontal: 16,
  },

  postanovlenie: {
    fontSize: 6,
    color: C_LIGHT,
    textAlign: 'right',
    marginBottom: 2,
  },

  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 1,
  },
  title: {
    flexGrow: 1,
    fontSize: 13,
    fontWeight: 'bold',
  },
  statusBox: {
    borderWidth: 0.7,
    borderColor: '#000',
    padding: 1,
    width: 240,
  },
  statusBoxTitle: {
    fontSize: 7,
    fontWeight: 'bold',
    marginBottom: 0,
  },
  statusBoxBody: {
    fontSize: 5.5,
    color: C_LIGHT,
    lineHeight: 1,
  },

  invoiceLine: {
    fontSize: 9.5,
    fontWeight: 'bold',
    marginTop: 1,
  },
  correctionLine: {
    fontSize: 8,
    marginBottom: 4,
  },
  fieldNum: {
    color: C_LIGHT,
    fontSize: 6.5,
  },

  partiesRow: {
    flexDirection: 'row',
    marginBottom: 4,
  },
  partyColLeft: {
    width: '50%',
    paddingRight: 4,
  },
  partyColRight: {
    width: '50%',
    paddingLeft: 4,
  },
  partyLine: {
    fontSize: 7.5,
    marginBottom: 1,
  },

  // Разлинованная сетка верхнего блока (счёт-фактура + стороны) по форме 1137:
  // внешняя чёрная рамка, строки с горизонтальными линиями, ячейки
  // «метка | значение | (номер поля)».
  g1Frame: { borderWidth: 0.75, borderColor: '#000', marginBottom: 1 },
  g1Row: { flexDirection: 'row', borderBottomWidth: 0.5, borderColor: '#000' },
  g1RowLast: { flexDirection: 'row' },
  g1Label: {
    width: '18%',
    padding: 3,
    fontSize: 7,
    borderRightWidth: 0.5,
    borderColor: '#000',
  },
  g1Value: { flex: 1, padding: 3, fontSize: 7.5 },
  g1Num: {
    width: 26,
    padding: 3,
    fontSize: 6,
    color: '#000',
    textAlign: 'center',
    borderLeftWidth: 0.5,
    borderColor: '#000',
  },
  g1TwoCol: { flexDirection: 'row' },
  g1ColLeft: { width: '50%', borderRightWidth: 0.5, borderColor: '#000' },
  g1ColRight: { width: '50%' },
  g1InvoiceLabel: { fontSize: 8, fontWeight: 'bold' },

  table: {
    marginTop: 2,
    borderTopWidth: 0.75,
    borderLeftWidth: 0.75,
    borderRightWidth: 0.75,
    borderBottomWidth: 0.75,
    borderColor: '#000',
  },
  thRow: {
    flexDirection: 'row',
    backgroundColor: '#f3f3f3',
    borderBottomWidth: 0.5,
    borderColor: '#000',
    minHeight: 42,
  },
  thWrap: {
    borderRightWidth: 0.5,
    borderColor: '#000',
    padding: 2,
    justifyContent: 'space-between',
  },
  thWrapLast: {
    padding: 2,
    justifyContent: 'space-between',
  },
  thGroupWrap: {
    borderRightWidth: 0.5,
    borderColor: '#000',
  },
  thGroupLabel: {
    fontSize: 5.8,
    fontWeight: 'bold',
    textAlign: 'center',
    padding: 2,
    borderBottomWidth: 0.5,
    borderColor: '#000',
  },
  thSubRow: {
    flexDirection: 'row',
    flexGrow: 1,
  },
  thSubWrap: {
    borderRightWidth: 0.5,
    borderColor: '#000',
    padding: 2,
    justifyContent: 'space-between',
  },
  thSubWrapLast: {
    padding: 2,
    justifyContent: 'space-between',
  },
  thLabel: {
    fontSize: 5.8,
    fontWeight: 'bold',
    textAlign: 'center',
  },
  thNum: {
    fontSize: 5.5,
    color: C_LIGHT,
    textAlign: 'center',
  },

  tdRow: {
    flexDirection: 'row',
    borderBottomWidth: 0.5,
    borderColor: '#000',
  },
  td: {
    fontSize: 7,
    padding: 2,
    borderRightWidth: 0.5,
    borderColor: '#000',
  },
  tdLast: {
    fontSize: 7,
    padding: 2,
  },
  tdGroup: {
    flexDirection: 'row',
    borderRightWidth: 0.5,
    borderColor: '#000',
  },
  tdGroupLast: {
    flexDirection: 'row',
  },
  tdSub: {
    fontSize: 7,
    padding: 2,
    borderRightWidth: 0.5,
    borderColor: '#000',
  },
  tdSubLast: {
    fontSize: 7,
    padding: 2,
  },
  center: { textAlign: 'center' },
  right: { textAlign: 'right' },
  bold: { fontWeight: 'bold' },

  totalsRow: {
    flexDirection: 'row',
    borderTopWidth: 0.75,
    borderColor: '#000',
    backgroundColor: '#fafafa',
  },
  totalsLabel: {
    width: '51%',
    fontSize: 7,
    fontWeight: 'bold',
    padding: 2,
    textAlign: 'right',
    borderRightWidth: 0.5,
    borderColor: '#000',
  },

  pagesNote: {
    fontSize: 7,
    marginTop: 2,
  },
  amountWords: {
    fontWeight: 'bold',
    fontSize: 8,
    marginTop: 2,
    marginBottom: 2,
  },

  sigBlock: { marginTop: 4 },
  sigSidesRow: { flexDirection: 'row' },
  sigSideLeft: { width: '50%', paddingRight: 6 },
  sigSideRight: { width: '50%', paddingLeft: 6, borderLeftWidth: 0.5, borderColor: C_BORDER },
  sigGroupLabel: {
    fontSize: 7,
    fontWeight: 'bold',
    marginTop: 4,
    marginBottom: 1,
  },
  sigCaption: {
    fontSize: 6,
    color: C_LIGHT,
    marginBottom: 1,
  },
  sigInlineRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginVertical: 1,
    fontSize: 7,
  },
  sigSlash: { fontSize: 7, paddingHorizontal: 2 },
  sigLine: {
    borderBottomWidth: 0.5,
    borderColor: '#444',
    height: 10,
    marginHorizontal: 2,
  },
  sigText: { fontSize: 7 },
  sigSmallNote: { fontSize: 6.5, marginTop: 2 },
  mp: { marginTop: 6, fontSize: 7, fontWeight: 'bold' },

  // Разлинованная сетка блока подписей формы 1137: внешняя чёрная рамка,
  // две колонки (продавец слева / покупатель справа) с вертикальным
  // разделителем, ячейки с горизонтальными линиями, ровные линии
  // под подпись/ФИО (g3PenWide) — растягиваются на доступную ширину.
  g3Frame: { borderWidth: 0.75, borderColor: '#000', marginTop: 2 },
  g3TwoCol: { flexDirection: 'row' },
  g3ColLeft: { width: '50%', borderRightWidth: 0.5, borderColor: '#000' },
  g3ColRight: { width: '50%' },
  g3Cell: { padding: 2, borderBottomWidth: 0.5, borderColor: '#000' },
  g3CellLast: { padding: 2 },
  g3RoleLabel: { fontSize: 7, fontWeight: 'bold', marginBottom: 2 },
  g3SignRow: { flexDirection: 'row', alignItems: 'flex-end', marginBottom: 1 },
  g3PenWide: {
    borderBottomWidth: 0.5,
    borderColor: '#000',
    flex: 1,
    marginHorizontal: 4,
    height: 10,
  },
  g3Caption: { fontSize: 5.5, color: '#555', textAlign: 'center' },
  g3Note: { fontSize: 6.5, marginTop: 2 },
  g3FieldNum: { fontSize: 6, color: '#000' },
  g3Mp: { fontSize: 7, fontWeight: 'bold', marginTop: 4 },

  // Зоны A/B/C блока подписей — на всю ширину (вне двухколоночной сетки)
  g3FullFrame: { borderWidth: 0.75, borderColor: '#000', marginTop: 2 },
  g3FullRow: { padding: 2, borderBottomWidth: 0.5, borderColor: '#000' },
  g3FullRowLast: { padding: 2 },
  g3HeadsRow: { flexDirection: 'row' },
  g3HeadCell: { flex: 1, paddingHorizontal: 3 },

  // Зона D блока подписей — парная сетка: левая/правая ячейка в ОДНОЙ строке,
  // синхронны по высоте (растягиваются под более высокую из пары через alignItems stretch)
  g3PairFrame: { borderWidth: 0.75, borderColor: '#000', marginTop: 2 },
  g3PairRow: {
    flexDirection: 'row',
    alignItems: 'stretch',
    borderBottomWidth: 0.5,
    borderColor: '#000',
  },
  g3PairRowLast: { flexDirection: 'row', alignItems: 'stretch' },
  g3PairLeft: {
    width: '50%',
    padding: 2,
    borderRightWidth: 0.5,
    borderColor: '#000',
  },
  g3PairRight: { width: '50%', padding: 2 },

  footer: {
    position: 'absolute',
    bottom: 8,
    left: 16,
    right: 16,
    fontSize: 6,
    textAlign: 'center',
    color: C_LIGHT,
  },
})

function FieldLine({ text, num }: { text: string; num: string }) {
  return (
    <Text style={styles.partyLine}>
      {text} <Text style={styles.fieldNum}>{num}</Text>
    </Text>
  )
}

function PenLine({ width }: { width: number | string }) {
  return <View style={[styles.sigLine, { width }]} />
}

function dayMonthYear(d: Date): { day: string; month: string; year: string } {
  return {
    day: String(d.getUTCDate()).padStart(2, '0'),
    month: MONTH_GENITIVE[d.getUTCMonth()],
    year: String(d.getUTCFullYear()),
  }
}

function baseLineText(b: UpdBuyerSnapshot): string {
  if (b.contractNumber) {
    const tail = b.contractDateIso
      ? ' от ' + formatDateNumeric(new Date(b.contractDateIso))
      : ''
    return `Договор № ${b.contractNumber}${tail}`
  }
  return 'Основной договор'
}

function Copy({ doc, copyLabel }: { doc: UpdPdfDocData; copyLabel: string }) {
  const { supplier, buyer, lines } = doc

  const totalNum = parseFloat(doc.totalAmount)
  const rub = Math.trunc(totalNum)
  const kop = Math.round((totalNum - rub) * 100)

  const innKppSupplier = `${supplier.inn}${supplier.kpp ? '/' + supplier.kpp : ''}`
  const innKppBuyer = buyer.inn
    ? `${buyer.inn}${buyer.kpp ? '/' + buyer.kpp : ''}`
    : '--'

  const buyerLegal = buyer.legalName ?? buyer.clientName
  const buyerAddr = buyer.legalAddress ?? '--'
  const consignee = `${buyerLegal}; ${buyer.locationName}, ${buyer.locationAddress}`

  const dateNumeric = formatDateNumeric(doc.deliveryDate)
  const { day, month, year } = dayMonthYear(doc.deliveryDate)

  const isIE = supplier.entityType === 'INDIVIDUAL_ENTREPRENEUR'
  const sellerHeadTitle = isIE
    ? 'Индивидуальный предприниматель'
    : 'Руководитель организации или иное уполномоченное лицо'

  const rateText = doc.vatRate ? `${doc.vatRate}%` : 'Без НДС'

  return (
    <>
      <Text style={styles.postanovlenie}>{POSTANOVLENIE}</Text>

      <View style={styles.titleRow}>
        <Text style={styles.title}>Универсальный передаточный документ</Text>
        <View style={styles.statusBox}>
          <Text style={styles.statusBoxTitle}>Статус: 1</Text>
          <Text style={styles.statusBoxBody}>
            1 — счёт-фактура и передаточный документ (акт){'\n'}
            2 — передаточный документ (акт)
          </Text>
        </View>
      </View>

      {/* Верхний блок (счёт-фактура + стороны) — разлинованная сетка формы 1137 */}
      <View style={styles.g1Frame}>
        {/* Счёт-фактура */}
        <View style={styles.g1Row}>
          <Text style={[styles.g1Label, styles.g1InvoiceLabel]}>Счёт-фактура №</Text>
          <Text style={[styles.g1Value, styles.g1InvoiceLabel]}>
            {doc.documentNumber} от {dateNumeric}
          </Text>
          <Text style={styles.g1Num}>(1)</Text>
        </View>

        {/* Исправление */}
        <View style={styles.g1Row}>
          <Text style={styles.g1Label}>Исправление №</Text>
          <Text style={styles.g1Value}>-- от --</Text>
          <Text style={styles.g1Num}>(1а)</Text>
        </View>

        {/* Две колонки: продавец (слева) / покупатель (справа) */}
        <View style={styles.g1TwoCol}>
          {/* Сторона продавца */}
          <View style={styles.g1ColLeft}>
            <View style={styles.g1Row}>
              <Text style={styles.g1Label}>Продавец</Text>
              <Text style={styles.g1Value}>{supplier.fullName}</Text>
              <Text style={styles.g1Num}>(2)</Text>
            </View>
            <View style={styles.g1Row}>
              <Text style={styles.g1Label}>Адрес</Text>
              <Text style={styles.g1Value}>{supplier.legalAddress}</Text>
              <Text style={styles.g1Num}>(2а)</Text>
            </View>
            <View style={styles.g1Row}>
              <Text style={styles.g1Label}>ИНН/КПП продавца</Text>
              <Text style={styles.g1Value}>{innKppSupplier}</Text>
              <Text style={styles.g1Num}>(2б)</Text>
            </View>
            <View style={styles.g1Row}>
              <Text style={styles.g1Label}>Грузоотправитель и его адрес</Text>
              <Text style={styles.g1Value}>он же</Text>
              <Text style={styles.g1Num}>(3)</Text>
            </View>
            <View style={styles.g1Row}>
              <Text style={styles.g1Label}>Грузополучатель и его адрес</Text>
              <Text style={styles.g1Value}>{consignee}</Text>
              <Text style={styles.g1Num}>(4)</Text>
            </View>
            <View style={styles.g1Row}>
              <Text style={styles.g1Label}>К платёжно-расчётному документу №</Text>
              <Text style={styles.g1Value}>-- от --</Text>
              <Text style={styles.g1Num}>(5)</Text>
            </View>
            <View style={styles.g1RowLast}>
              <Text style={styles.g1Label}>Документ об отгрузке</Text>
              <Text style={styles.g1Value}>
                Универсальный передаточный документ № {doc.documentNumber} от {dateNumeric}
              </Text>
              <Text style={styles.g1Num}>(5а)</Text>
            </View>
          </View>

          {/* Сторона покупателя */}
          <View style={styles.g1ColRight}>
            <View style={styles.g1Row}>
              <Text style={styles.g1Label}>Покупатель</Text>
              <Text style={styles.g1Value}>{buyerLegal}</Text>
              <Text style={styles.g1Num}>(6)</Text>
            </View>
            <View style={styles.g1Row}>
              <Text style={styles.g1Label}>Адрес</Text>
              <Text style={styles.g1Value}>{buyerAddr}</Text>
              <Text style={styles.g1Num}>(6а)</Text>
            </View>
            <View style={styles.g1Row}>
              <Text style={styles.g1Label}>ИНН/КПП покупателя</Text>
              <Text style={styles.g1Value}>{innKppBuyer}</Text>
              <Text style={styles.g1Num}>(6б)</Text>
            </View>
            <View style={styles.g1Row}>
              <Text style={styles.g1Label}>Валюта: наименование, код</Text>
              <Text style={styles.g1Value}>Российский рубль, 643</Text>
              <Text style={styles.g1Num}>(7)</Text>
            </View>
            <View style={styles.g1RowLast}>
              <Text style={styles.g1Label}>
                Идентификатор государственного контракта, договора (соглашения) (при наличии)
              </Text>
              <Text style={styles.g1Value}>--</Text>
              <Text style={styles.g1Num}>(8)</Text>
            </View>
          </View>
        </View>
      </View>

      {/* Таблица позиций */}
      <View style={styles.table}>
        {/* Шапка таблицы */}
        <View style={styles.thRow}>
          <View style={[styles.thWrap, { width: COL.codeTRU }]}>
            <Text style={styles.thLabel}>Код товара/работ услуг</Text>
            <Text style={styles.thNum}>А</Text>
          </View>
          <View style={[styles.thWrap, { width: COL.no }]}>
            <Text style={styles.thLabel}>№ п/п</Text>
            <Text style={styles.thNum}>1</Text>
          </View>
          <View style={[styles.thWrap, { width: COL.name }]}>
            <Text style={styles.thLabel}>
              Наименование товара (описание работ, услуг), имущественного права
            </Text>
            <Text style={styles.thNum}>1а</Text>
          </View>
          <View style={[styles.thWrap, { width: COL.codeKind }]}>
            <Text style={styles.thLabel}>Код вида товара</Text>
            <Text style={styles.thNum}>1б</Text>
          </View>
          {/* Единица измерения — двухуровневый заголовок */}
          <View style={[styles.thGroupWrap, { width: COL.unitGroup }]}>
            <Text style={styles.thGroupLabel}>Единица измерения</Text>
            <View style={styles.thSubRow}>
              <View style={[styles.thSubWrap, { width: '43%' }]}>
                <Text style={styles.thLabel}>код</Text>
                <Text style={styles.thNum}>2</Text>
              </View>
              <View style={[styles.thSubWrapLast, { width: '57%' }]}>
                <Text style={styles.thLabel}>условное обозначение (национальное)</Text>
                <Text style={styles.thNum}>2а</Text>
              </View>
            </View>
          </View>
          <View style={[styles.thWrap, { width: COL.qty }]}>
            <Text style={styles.thLabel}>Количество (объём)</Text>
            <Text style={styles.thNum}>3</Text>
          </View>
          <View style={[styles.thWrap, { width: COL.price }]}>
            <Text style={styles.thLabel}>Цена (тариф) за единицу измерения</Text>
            <Text style={styles.thNum}>4</Text>
          </View>
          <View style={[styles.thWrap, { width: COL.totalWithoutVat }]}>
            <Text style={styles.thLabel}>
              Стоимость товаров (работ, услуг) без налога — всего
            </Text>
            <Text style={styles.thNum}>5</Text>
          </View>
          <View style={[styles.thWrap, { width: COL.excise }]}>
            <Text style={styles.thLabel}>В том числе сумма акциза</Text>
            <Text style={styles.thNum}>6</Text>
          </View>
          <View style={[styles.thWrap, { width: COL.rate }]}>
            <Text style={styles.thLabel}>Налоговая ставка</Text>
            <Text style={styles.thNum}>7</Text>
          </View>
          <View style={[styles.thWrap, { width: COL.vat }]}>
            <Text style={styles.thLabel}>
              Сумма налога, предъявляемая покупателю
            </Text>
            <Text style={styles.thNum}>8</Text>
          </View>
          <View style={[styles.thWrap, { width: COL.totalWithVat }]}>
            <Text style={styles.thLabel}>
              Стоимость товаров (работ, услуг) с налогом — всего
            </Text>
            <Text style={styles.thNum}>9</Text>
          </View>
          {/* Страна происхождения — двухуровневый заголовок */}
          <View style={[styles.thGroupWrap, { width: COL.countryGroup }]}>
            <Text style={styles.thGroupLabel}>Страна происхождения товара</Text>
            <View style={styles.thSubRow}>
              <View style={[styles.thSubWrap, { width: '40%' }]}>
                <Text style={styles.thLabel}>цифровой код</Text>
                <Text style={styles.thNum}>10</Text>
              </View>
              <View style={[styles.thSubWrapLast, { width: '60%' }]}>
                <Text style={styles.thLabel}>краткое наименование</Text>
                <Text style={styles.thNum}>10а</Text>
              </View>
            </View>
          </View>
          <View style={[styles.thWrapLast, { width: COL.customs }]}>
            <Text style={styles.thLabel}>
              Регистрационный номер декларации на товары / партии товара
            </Text>
            <Text style={styles.thNum}>11</Text>
          </View>
        </View>

        {/* Строки данных */}
        {lines.map((l, idx) => (
          <View key={l.orderId} style={styles.tdRow}>
            <Text style={[styles.td, styles.center, { width: COL.codeTRU }]}>--</Text>
            <Text style={[styles.td, styles.center, { width: COL.no }]}>{idx + 1}</Text>
            <Text style={[styles.td, { width: COL.name }]}>
              Реализация готовых обедов ({l.mealLabel}),{' '}
              {formatDateNumeric(new Date(l.deliveryDateIso))}
            </Text>
            <Text style={[styles.td, styles.center, { width: COL.codeKind }]}>--</Text>
            <View style={[styles.tdGroup, { width: COL.unitGroup }]}>
              <Text style={[styles.tdSub, styles.center, { width: '43%' }]}>796</Text>
              <Text style={[styles.tdSubLast, styles.center, { width: '57%' }]}>шт</Text>
            </View>
            <Text style={[styles.td, styles.right, { width: COL.qty }]}>{l.portions}</Text>
            <Text style={[styles.td, styles.right, { width: COL.price }]}>
              {l.pricePerPortion}
            </Text>
            <Text style={[styles.td, styles.right, { width: COL.totalWithoutVat }]}>
              {l.lineTotalWithoutVat}
            </Text>
            <Text style={[styles.td, styles.center, { width: COL.excise }]}>
              Без акциза
            </Text>
            <Text style={[styles.td, styles.center, { width: COL.rate }]}>
              {rateText}
            </Text>
            <Text style={[styles.td, styles.right, { width: COL.vat }]}>
              {l.lineVat ?? '--'}
            </Text>
            <Text style={[styles.td, styles.right, { width: COL.totalWithVat }]}>
              {l.lineTotal}
            </Text>
            <View style={[styles.tdGroup, { width: COL.countryGroup }]}>
              <Text style={[styles.tdSub, styles.center, { width: '40%' }]}>--</Text>
              <Text style={[styles.tdSubLast, styles.center, { width: '60%' }]}>--</Text>
            </View>
            <Text style={[styles.tdLast, styles.center, { width: COL.customs }]}>--</Text>
          </View>
        ))}

        {/* Строка "Всего к оплате (9)" */}
        <View style={styles.totalsRow}>
          <Text style={styles.totalsLabel}>
            Всего к оплате <Text style={styles.fieldNum}>(9)</Text>
          </Text>
          <Text style={[styles.td, styles.right, styles.bold, { width: COL.totalWithoutVat }]}>
            {doc.amountWithoutVat}
          </Text>
          <Text style={[styles.td, styles.center, { width: COL.excise }]}>Х</Text>
          <Text style={[styles.td, styles.center, { width: COL.rate }]}>Х</Text>
          <Text style={[styles.td, styles.right, styles.bold, { width: COL.vat }]}>
            {doc.vatAmount ?? 'Х'}
          </Text>
          <Text style={[styles.td, styles.right, styles.bold, { width: COL.totalWithVat }]}>
            {doc.totalAmount}
          </Text>
          <Text style={[styles.td, styles.center, { width: COL.countryGroup }]}>Х</Text>
          <Text style={[styles.tdLast, styles.center, { width: COL.customs }]}>Х</Text>
        </View>
      </View>

      <Text style={styles.pagesNote}>Документ составлен на <Text style={styles.bold}>1</Text> листе</Text>

      <Text style={styles.amountWords}>
        Всего к оплате прописью: {amountToWords(rub, kop)} ({formatMoney(doc.totalAmount, { withKopecks: true })})
      </Text>

      {/* Зоны A/B/C блока подписей — на всю ширину (форма 1137) */}
      <View style={styles.g3FullFrame}>
        {/* Зона A: Руководитель / Главбух / ИП + ОГРНИП-сноска */}
        <View style={styles.g3FullRow}>
          <View style={styles.g3HeadsRow}>
            <View style={styles.g3HeadCell}>
              <Text style={styles.g3RoleLabel}>{sellerHeadTitle}</Text>
              <View style={styles.g3SignRow}>
                <View style={styles.g3PenWide} />
                <Text style={styles.sigSlash}>/</Text>
                <Text style={styles.sigText}>{supplier.directorName}</Text>
              </View>
              <Text style={styles.g3Caption}>(подпись) / (ф.и.о.)</Text>
            </View>
            <View style={styles.g3HeadCell}>
              <Text style={styles.g3RoleLabel}>Главный бухгалтер или иное уполномоченное лицо</Text>
              <View style={styles.g3SignRow}>
                <View style={styles.g3PenWide} />
                <Text style={styles.sigSlash}>/</Text>
                <View style={styles.g3PenWide} />
              </View>
              <Text style={styles.g3Caption}>(подпись) / (ф.и.о.)</Text>
            </View>
          </View>
          {isIE ? (
            <Text style={styles.g3Note}>
              Основной государственный регистрационный номер ИП и дата присвоения: ОГРНИП {supplier.ogrn}
            </Text>
          ) : null}
        </View>
        {/* Зона B: Основание [8] */}
        <View style={styles.g3FullRow}>
          <Text style={styles.g3Note}>
            Основание передачи (сдачи) / получения (приёмки): {baseLineText(buyer)}{' '}
            <Text style={styles.g3FieldNum}>[8]</Text>
          </Text>
        </View>
        {/* Зона C: Данные о транспортировке [9] */}
        <View style={styles.g3FullRowLast}>
          <View style={styles.g3SignRow}>
            <Text style={styles.sigText}>Данные о транспортировке и грузе:</Text>
            <View style={styles.g3PenWide} />
            <Text style={styles.g3FieldNum}>[9]</Text>
          </View>
        </View>
      </View>

      {/* Зона D: парная двухколоночная сетка (форма 1137) — строки синхронны слева/справа */}
      <View style={styles.g3PairFrame}>
        {/* [10] / [15] Товар передал / получил */}
        <View style={styles.g3PairRow}>
          <View style={styles.g3PairLeft}>
            <Text style={styles.g3RoleLabel}>
              Товар (груз) передал / услуги сдал <Text style={styles.g3FieldNum}>[10]</Text>
            </Text>
            <View style={styles.g3SignRow}>
              <Text style={styles.sigText}>{supplier.directorPosition}</Text>
              <Text style={styles.sigSlash}>/</Text>
              <View style={styles.g3PenWide} />
              <Text style={styles.sigSlash}>/</Text>
              <Text style={styles.sigText}>{supplier.directorName}</Text>
            </View>
            <Text style={styles.g3Caption}>(должность) / (подпись) / (ф.и.о.)</Text>
          </View>
          <View style={styles.g3PairRight}>
            <Text style={styles.g3RoleLabel}>
              Товар (груз) получил / услуги принял <Text style={styles.g3FieldNum}>[15]</Text>
            </Text>
            <View style={styles.g3SignRow}>
              <View style={styles.g3PenWide} />
              <Text style={styles.sigSlash}>/</Text>
              <View style={styles.g3PenWide} />
              <Text style={styles.sigSlash}>/</Text>
              <View style={styles.g3PenWide} />
            </View>
            <Text style={styles.g3Caption}>(должность) / (подпись) / (ф.и.о.)</Text>
          </View>
        </View>
        {/* [11] / [16] Дата отгрузки / получения */}
        <View style={styles.g3PairRow}>
          <View style={styles.g3PairLeft}>
            <Text style={styles.g3Note}>
              Дата отгрузки, передачи (сдачи) « {day} » {month} {year} года{' '}
              <Text style={styles.g3FieldNum}>[11]</Text>
            </Text>
          </View>
          <View style={styles.g3PairRight}>
            <Text style={styles.g3Note}>
              Дата получения (приёмки) « __ » __________ 20__ года{' '}
              <Text style={styles.g3FieldNum}>[16]</Text>
            </Text>
          </View>
        </View>
        {/* [12] / [17] Иные сведения */}
        <View style={styles.g3PairRow}>
          <View style={styles.g3PairLeft}>
            <Text style={styles.g3Note}>
              Иные сведения об отгрузке, передаче{' '}
              <Text style={styles.g3FieldNum}>[12]</Text>
            </Text>
          </View>
          <View style={styles.g3PairRight}>
            <Text style={styles.g3Note}>
              Иные сведения о получении, приёмке{' '}
              <Text style={styles.g3FieldNum}>[17]</Text>
            </Text>
          </View>
        </View>
        {/* [13] / [18] Ответственный */}
        <View style={styles.g3PairRow}>
          <View style={styles.g3PairLeft}>
            <Text style={styles.g3RoleLabel}>
              Ответственный за правильность оформления факта хозяйственной жизни{' '}
              <Text style={styles.g3FieldNum}>[13]</Text>
            </Text>
            <View style={styles.g3SignRow}>
              <View style={styles.g3PenWide} />
              <Text style={styles.sigSlash}>/</Text>
              <View style={styles.g3PenWide} />
              <Text style={styles.sigSlash}>/</Text>
              <View style={styles.g3PenWide} />
            </View>
            <Text style={styles.g3Caption}>(должность) / (подпись) / (ф.и.о.)</Text>
          </View>
          <View style={styles.g3PairRight}>
            <Text style={styles.g3RoleLabel}>
              Ответственный за правильность оформления факта хозяйственной жизни{' '}
              <Text style={styles.g3FieldNum}>[18]</Text>
            </Text>
            <View style={styles.g3SignRow}>
              <View style={styles.g3PenWide} />
              <Text style={styles.sigSlash}>/</Text>
              <View style={styles.g3PenWide} />
              <Text style={styles.sigSlash}>/</Text>
              <View style={styles.g3PenWide} />
            </View>
            <Text style={styles.g3Caption}>(должность) / (подпись) / (ф.и.о.)</Text>
          </View>
        </View>
        {/* [14] / [19] Составитель */}
        <View style={styles.g3PairRow}>
          <View style={styles.g3PairLeft}>
            <Text style={styles.g3Note}>
              Наименование экономического субъекта — составителя документа{' '}
              <Text style={styles.g3FieldNum}>[14]</Text>: {supplier.fullName}, ИНН {innKppSupplier}
            </Text>
          </View>
          <View style={styles.g3PairRight}>
            <Text style={styles.g3Note}>
              Наименование экономического субъекта — составителя документа{' '}
              <Text style={styles.g3FieldNum}>[19]</Text>: {buyerLegal}
              {buyer.inn ? ', ИНН ' + innKppBuyer : ''}
            </Text>
          </View>
        </View>
        {/* М.П. / М.П. */}
        <View style={styles.g3PairRowLast}>
          <View style={styles.g3PairLeft}>
            <Text style={styles.g3Mp}>М.П.</Text>
          </View>
          <View style={styles.g3PairRight}>
            <Text style={styles.g3Mp}>М.П.</Text>
          </View>
        </View>
      </View>
    </>
  )
}

export function UpdPdfDocument({ docs }: { docs: UpdPdfDocData[] }) {
  return (
    <Document>
      {docs.flatMap((d) => [
        <Page
          key={`${d.documentNumber}-1`}
          size="A4"
          orientation="landscape"
          style={styles.page}
        >
          <Copy doc={d} copyLabel={COPY_LABEL_SELLER} />
        </Page>,
        <Page
          key={`${d.documentNumber}-2`}
          size="A4"
          orientation="landscape"
          style={styles.page}
        >
          <Copy doc={d} copyLabel={COPY_LABEL_BUYER} />
        </Page>,
      ])}
    </Document>
  )
}
