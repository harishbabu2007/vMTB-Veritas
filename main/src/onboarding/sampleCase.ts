// Everything the walkthrough's samples show. The sample case never reaches
// the document pipeline or the database: the tour drops public/sample's PDF
// into the wizard as an ordinary-looking file, and /sample-case shows a
// ready-made result. /sample-board is a board replica with no meeting code.
// Replace the PDF and the text below together so they describe the same case.

export const SAMPLE_PDF_URL = '/sample/sample-case-report.pdf';
export const SAMPLE_FILE_NAME = 'sample-case-report.pdf';
export const SAMPLE_PAGE_COUNT = 3;

export const SAMPLE_CANCER_TYPE = 'Lung Cancer';
export const SAMPLE_AGE = 58;
export const SAMPLE_SEX = 'Male';

export const SAMPLE_SUMMARY = `## Diagnosis
Lung adenocarcinoma, right upper lobe, moderately differentiated (CT-guided core biopsy).

## Stage of Disease
Clinical stage IVA: right upper lobe primary (4.2 × 3.6 cm) with right hilar and subcarinal nodes and two liver lesions suspicious for metastases.

## Molecular Profile
- **EGFR** exon 19 deletion (p.E746_A750del), VAF 22%
- **TP53** p.R273H, VAF 18%
- Negative for ALK, ROS1, RET and NTRK fusions; KRAS, BRAF V600E and MET exon 14 skipping
- TMB 4 mut/Mb (low); MSI stable

## Immunohistochemistry
TTF-1 and Napsin A positive, p40 negative. PD-L1 (22C3) TPS 30%.

## Clinical Information
- ECOG performance status 1
- No bone lesions and no pleural effusion on CT

## Questions for the Board
- First-line choice for EGFR exon 19 deletion with a co-occurring TP53 mutation
- Whether the liver lesions need biopsy confirmation before starting treatment
`;

export interface SampleOpinion {
  id: string;
  author: string;
  role: string;
  content: string;
  createdAt: string;
}

export const SAMPLE_SEED_OPINION: SampleOpinion = {
  id: 'sample-opinion-1',
  author: 'Dr. Demo Oncologist',
  role: 'Medical oncology',
  content:
    'EGFR exon 19 deletion with stage IVA disease: first-line osimertinib is the preferred option. The TP53 co-mutation may shorten response duration, so plan closer imaging follow-up.',
  createdAt: new Date().toISOString(),
};

export const SAMPLE_TREATMENT_PLAN = {
  discussionDate: 'Board discussion (sample)',
  recommendation: 'Osimertinib 80 mg once daily as first-line therapy.',
  pathway: 'EGFR-targeted therapy',
  ampLevel: 'Tier I, Level A',
  escatLevel: 'ESCAT I-A',
  evidence: 'Strong',
  followUp: {
    label: 'Follow-up at 3 months (sample)',
    status: 'Partial response on CT; liver lesions smaller.',
    notes: 'Tolerating treatment well. Next scan in 3 months.',
  },
};

export const SAMPLE_BOARD = {
  name: 'Sample Thoracic Tumor Board',
  experts: 4,
  inviteCode: 'SAMPLE',
  cases: [
    {
      id: 'sample-board-case-1',
      caseName: 'LungCancer-sample',
      cancerType: 'Lung Cancer',
      owner: 'Dr. Demo Oncologist',
      opinions: 3,
    },
  ],
};
