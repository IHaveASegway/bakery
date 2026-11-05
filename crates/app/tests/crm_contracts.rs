//! The CRM's wire enums and the domain's agree name for name: a segment, a template, a message
//! kind, a lead stage or a campaign state the domain knows reads back from the contract's JSON.

use bakery_contracts as wire;
use bakery_domain::crm::{BodyTemplate, CampaignState, LeadStage, Segment, SubjectTemplate};
use bakery_domain::inbox::MessageKind;
use serde::Serialize;
use serde::de::DeserializeOwned;

fn same<D: Serialize, W: Serialize + DeserializeOwned>(domain: D) {
    let text = serde_json::to_value(&domain).unwrap();
    let wire: W = serde_json::from_value(text.clone())
        .unwrap_or_else(|e| panic!("{text} is not on the wire: {e}"));
    assert_eq!(serde_json::to_value(wire).unwrap(), text);
}

#[test]
fn the_domain_and_the_wire_name_everything_alike() {
    for s in Segment::ALL {
        same::<_, wire::Segment>(s);
    }
    for s in SubjectTemplate::ALL {
        same::<_, wire::SubjectTemplate>(s);
    }
    for b in BodyTemplate::ALL {
        same::<_, wire::BodyTemplate>(b);
    }
    for s in LeadStage::ALL {
        same::<_, wire::LeadStage>(s);
    }
    for s in [
        CampaignState::Draft,
        CampaignState::Scheduled,
        CampaignState::Sent,
        CampaignState::Cancelled,
    ] {
        same::<_, wire::CampaignState>(s);
    }
    for k in [
        MessageKind::Receipt,
        MessageKind::Ready,
        MessageKind::OnItsWay,
        MessageKind::Refund,
        MessageKind::Declined,
        MessageKind::Acknowledgement,
        MessageKind::Quote,
        MessageKind::Notice,
        MessageKind::Reminder,
        MessageKind::Invoice,
        MessageKind::Campaign,
    ] {
        same::<_, wire::MessageKind>(k);
        assert_eq!(serde_json::to_value(k).unwrap(), k.as_str());
    }
}
